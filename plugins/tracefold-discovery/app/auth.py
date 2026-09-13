from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlparse

from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright

from .storage import AccountStore


TOKEN_KEY_RE = re.compile(r"(^|[_-])(access|auth|id|bearer)?[_-]?token$|jwt", re.I)
JWT_RE = re.compile(r"^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")


class CaptureSession:
    def __init__(self, playwright: Playwright, browser: Browser, context: BrowserContext, page: Page) -> None:
        self.playwright = playwright
        self.browser = browser
        self.context = context
        self.page = page


class SessionCaptureManager:
    def __init__(self, accounts: AccountStore) -> None:
        self.accounts = accounts
        self.sessions: dict[str, CaptureSession] = {}

    async def start(self, account_id: str) -> dict[str, str]:
        if account_id in self.sessions:
            return {"status": "already_open"}
        account = self.accounts.get_runtime(account_id)
        playwright = await async_playwright().start()
        browser: Browser | None = None
        try:
            browser = await playwright.chromium.launch(headless=False)
            context_options: dict[str, Any] = {
                "ignore_https_errors": bool(account.get("ignore_https_errors", False)),
            }
            if account.get("storage_state"):
                context_options["storage_state"] = account["storage_state"]
            context = await browser.new_context(**context_options)
            await self._restore_session_storage(context, account.get("session_storage", {}))
            page = await context.new_page()
            await page.goto(account["login_url"], wait_until="domcontentloaded", timeout=120000)
            session = CaptureSession(playwright, browser, context, page)
            self.sessions[account_id] = session
            if account["auth_mode"] == "form":
                await page.locator(account["username_selector"]).first.fill(account["username"])
                await page.locator(account["password_selector"]).first.fill(account["password"])
                await page.locator(account["submit_selector"]).first.click()
            return {"status": "opened"}
        except Exception:
            if browser:
                await browser.close()
            await playwright.stop()
            raise

    async def finish(self, account_id: str) -> dict[str, Any]:
        session = self.sessions.pop(account_id, None)
        if not session:
            raise KeyError(account_id)
        try:
            try:
                storage_state = await session.context.storage_state(indexed_db=True)
            except TypeError:
                storage_state = await session.context.storage_state()
            session_storage: dict[str, dict[str, str]] = {}
            candidates: list[tuple[str, str]] = []
            for page in session.context.pages:
                try:
                    values = await page.evaluate("""() => ({
                        origin: location.origin,
                        local: Object.fromEntries(Object.entries(localStorage)),
                        session: Object.fromEntries(Object.entries(sessionStorage))
                    })""")
                    session_storage[values["origin"]] = values["session"]
                    candidates.extend(self._token_candidates(values["local"]))
                    candidates.extend(self._token_candidates(values["session"]))
                except Exception:
                    continue
            account = self.accounts.get_runtime(account_id)
            captured_token = self._choose_token(candidates, account.get("token_storage_key", ""))
            saved = self.accounts.save_session(account_id, {
                "storage_state": storage_state,
                "session_storage": session_storage,
                "captured_token": captured_token,
            })
            return saved
        finally:
            await session.context.close()
            await session.browser.close()
            await session.playwright.stop()

    async def cancel(self, account_id: str) -> None:
        session = self.sessions.pop(account_id, None)
        if not session:
            return
        await session.context.close()
        await session.browser.close()
        await session.playwright.stop()

    @staticmethod
    async def _restore_session_storage(context: BrowserContext, values: dict[str, dict[str, str]]) -> None:
        if not values:
            return
        encoded = json.dumps(values).replace("</", "<\\/")
        script = f"""(() => {{
          const all = {encoded};
          const current = all[location.origin] || {{}};
          for (const [key, value] of Object.entries(current)) sessionStorage.setItem(key, value);
        }})()"""
        await context.add_init_script(script=script)

    @classmethod
    def _token_candidates(cls, values: dict[str, str]) -> list[tuple[str, str]]:
        candidates: list[tuple[str, str]] = []
        for key, raw in values.items():
            if TOKEN_KEY_RE.search(key) or JWT_RE.match(raw):
                candidates.append((key, raw))
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    for nested_key, nested_value in parsed.items():
                        if TOKEN_KEY_RE.search(nested_key) and isinstance(nested_value, str):
                            candidates.append((f"{key}.{nested_key}", nested_value))
            except (json.JSONDecodeError, TypeError):
                pass
        return candidates

    @staticmethod
    def _choose_token(candidates: list[tuple[str, str]], requested_key: str) -> str:
        if requested_key:
            for key, value in candidates:
                if key.lower() == requested_key.lower() or key.lower().endswith("." + requested_key.lower()):
                    return value
        jwt = next((value for _, value in candidates if JWT_RE.match(value)), "")
        return jwt or (candidates[0][1] if candidates else "")


def account_auth_context(account: dict[str, Any]) -> dict[str, Any]:
    mode = account.get("auth_mode")
    # Scoped to the active mode on purpose. A bearer account authenticates with its typed
    # token; interactive and form accounts authenticate with the session they captured.
    # Falling back across modes would keep sending a credential the user has switched away
    # from, which is exactly what changing the mode is meant to stop.
    if mode == "bearer":
        token = account.get("bearer_token") or ""
        storage_state = None
        session_storage: dict[str, Any] = {}
    else:
        token = account.get("captured_token") or ""
        storage_state = account.get("storage_state")
        session_storage = account.get("session_storage", {})
    return {
        "account_id": account["id"],
        "account_name": account["name"],
        "base_url": account["base_url"],
        "bearer_token": token,
        "storage_state": storage_state,
        "session_storage": session_storage,
        "extra_headers": account.get("extra_headers", {}),
        "allowed_origins": account.get("allowed_origins", []),
        "variables": account.get("variables", {}),
        "auth_mode": account.get("auth_mode"),
    }
