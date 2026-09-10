<script lang="ts">
  import { t, codeLabel, intlLocale, date } from '../i18n/i18n.svelte';

  import { onMount, untrack } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import Placeholder from '@tiptap/extension-placeholder';
  import { TableKit } from '@tiptap/extension-table';
  import TaskList from '@tiptap/extension-task-list';
  import TaskItem from '@tiptap/extension-task-item';
  import type { RichDocument } from '../domain/types';
  import Icon from './Icon.svelte';
  let {
    value,
    onchange,
    placeholder,
    compact = false,
    readonly = false,
  }: {
    value: RichDocument;
    onchange?: (value: RichDocument) => void;
    placeholder?: string;
    compact?: boolean;
    readonly?: boolean;
  } = $props();
  let element: HTMLDivElement;
  let editor = $state<Editor | null>(null);
  let transaction = $state(0);
  onMount(() => {
    const instance = new Editor({
      element,
      extensions: [
        StarterKit.configure({ link: { openOnClick: false } }),
        Placeholder.configure({ placeholder: () => placeholder ?? t('Write what matters…') }),
        TableKit,
        TaskList,
        TaskItem.configure({ nested: true }),
      ],
      content: value,
      editable: !readonly,
      editorProps: {
        attributes: readonly
          ? { role: 'document', 'aria-label': t('Recorded observation') }
          : { role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('Document content') },
      },
      onUpdate: ({ editor }) => onchange?.(editor.getJSON() as RichDocument),
      // Editor commands may run inside a locale/content effect. Their callback must
      // not subscribe that effect to the toolbar counter it is about to increment.
      onTransaction: () => untrack(() => transaction++),
    });
    editor = instance;
    return () => instance.destroy();
  });
  $effect(() => {
    const label = t(readonly ? 'Recorded observation' : 'Document content');
    const hint = placeholder ?? t('Write what matters…');
    if (editor) {
      editor.setOptions({
        editorProps: {
          attributes: readonly
            ? { role: 'document', 'aria-label': label }
            : { role: 'textbox', 'aria-multiline': 'true', 'aria-label': label },
        },
      });
      // Refresh placeholder decorations and accessibility labels without replacing document content.
      editor.view.dispatch(editor.state.tr.setMeta('tracefold-locale', hint));
    }
  });
  $effect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(value))
      editor.commands.setContent(value, { emitUpdate: false });
  });
  const active = (name: string) => {
    void transaction;
    return editor?.isActive(name) ?? false;
  };
</script>

<div class:compact class:readonly class="rich-editor">
  {#if !readonly}<div class="editor-toolbar" role="toolbar" aria-label={t('Text formatting')}>
      <select
        aria-label={t('Text style')}
        onchange={(e) => {
          const level = Number(e.currentTarget.value);
          if (level)
            editor
              ?.chain()
              .focus()
              .toggleHeading({ level: level as 1 | 2 | 3 })
              .run();
          else editor?.chain().focus().setParagraph().run();
        }}
        ><option value="0">{t('Normal text')}</option><option value="1">{t('Heading 1')}</option
        ><option value="2">{t('Heading 2')}</option><option value="3">{t('Heading 3')}</option
        ></select
      >
      <span class="toolbar-divider"></span>
      <button
        class:active={active('bold')}
        class="icon-button"
        title={t('Bold')}
        aria-label={t('Bold')}
        aria-pressed={active('bold')}
        onclick={() => editor?.chain().focus().toggleBold().run()}
        ><Icon name="bold" size={18} /></button
      >
      <button
        class:active={active('italic')}
        class="icon-button"
        title={t('Italic')}
        aria-label={t('Italic')}
        aria-pressed={active('italic')}
        onclick={() => editor?.chain().focus().toggleItalic().run()}
        ><Icon name="italic" size={18} /></button
      >
      <button
        class="icon-button"
        title={t('Bullet list')}
        aria-label={t('Bullet list')}
        onclick={() => editor?.chain().focus().toggleBulletList().run()}
        ><Icon name="list" size={18} /></button
      >
      <button
        class="icon-button"
        title={t('Checklist')}
        aria-label={t('Checklist')}
        onclick={() => editor?.chain().focus().toggleTaskList().run()}
        ><Icon name="case" size={18} /></button
      >
      <button
        class="icon-button"
        title={t('Code block')}
        aria-label={t('Code block')}
        onclick={() => editor?.chain().focus().toggleCodeBlock().run()}
        ><Icon name="code" size={18} /></button
      >
      {#if !compact}<button
          class="icon-button"
          title={t('Insert table')}
          aria-label={t('Insert table')}
          onclick={() =>
            editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          ><Icon name="table" size={18} /></button
        >{/if}
    </div>{/if}
  <div bind:this={element}></div>
</div>
