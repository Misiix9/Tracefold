use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, io::Read};

// Release-side verification only. This executable never needs the private signing key.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 4 {
        return Err(
            "usage: tracefold-release-check PUBLIC_KEY_BASE64 ARTIFACT SIGNATURE_FILE".into(),
        );
    }
    let key_text = String::from_utf8(STANDARD.decode(&args[1])?)?;
    let signature_text = String::from_utf8(STANDARD.decode(fs::read_to_string(&args[3])?.trim())?)?;
    let key = PublicKey::decode(&key_text)?;
    let signature = Signature::decode(&signature_text)?;
    let mut verifier = key.verify_stream(&signature)?;
    let mut file = fs::File::open(&args[2])?;
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        verifier.update(&buffer[..count]);
    }
    verifier.finalize()?;
    println!("Verified update signature: {}", args[2]);
    Ok(())
}
