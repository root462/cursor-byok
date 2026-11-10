//! Generates Cursor protobuf bindings and validates captured wire contracts.
use std::{env, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let proto_dir = manifest.join("../protocols/cursor");
    let protos = [proto_dir.join("agent_v1.proto")];
    let aiserver_proto = proto_dir.join("aiserver_v1.proto");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let out_agent_v1 = out_dir.join("agent.v1.rs");
    let fallback = manifest.join("src/cursor/protocol/agent.v1.rs");

    if fallback.exists() {
        std::fs::copy(&fallback, &out_agent_v1).expect("copy fallback agent.v1.rs");
    } else {
        env::set_var(
            "PROTOC",
            protoc_bin_vendored::protoc_bin_path().expect("vendored protoc"),
        );
        let protoc_proto_dir = ascii_proto_dir(&proto_dir);
        prost_build::Config::new()
            .compile_protos(
                &[protoc_proto_dir.join("agent_v1.proto")],
                &[
                    protoc_proto_dir,
                    protoc_bin_vendored::include_path().expect("vendored protobuf includes"),
                ],
            )
            .expect("compile Cursor protobuf schema");
        let _ = std::fs::copy(&out_agent_v1, &fallback);
    }

    for proto in protos {
        println!("cargo:rerun-if-changed={}", proto.display());
    }
    let aiserver_source = std::fs::read_to_string(&aiserver_proto).expect("read aiserver_v1.proto");
    for required in [
        "message BidiAppendRequest",
        "string data = 1;",
        "BidiRequestId request_id = 2;",
        "int64 append_seqno = 3;",
        "bytes data_binary = 4;",
        "message BidiAppendResponse",
        "message CustomErrorDetails",
        "optional bool is_retryable = 4;",
        "optional bool show_request_id = 5;",
        "optional bool should_show_immediate_error = 6;",
        "message ErrorDetails",
        "ERROR_PROVIDER_ERROR = 57;",
        "CustomErrorDetails details = 2;",
        "optional bool is_expected = 3;",
    ] {
        assert!(
            aiserver_source.contains(required),
            "aiserver Bidi wire schema changed: missing {required}"
        );
    }
    // The extracted aiserver file currently contains unrelated duplicate message names, so
    // compiling that entire package would generate invalid Rust. `cursor/proto.rs` defines only
    // the validated Bidi and ErrorDetails wire subsets; agent_v1.proto remains fully generated.
    println!("cargo:rerun-if-changed={}", aiserver_proto.display());
}

/// protoc cannot open paths containing non-ASCII characters on Windows, and the workspace
/// may live under such a directory. Mirror the proto sources into an ASCII build directory
/// and compile from there.
fn ascii_proto_dir(proto_dir: &std::path::Path) -> PathBuf {
    let staging = std::env::temp_dir().join("cursor-byok-protos");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).expect("create proto staging directory");
    for entry in std::fs::read_dir(proto_dir).expect("read proto directory") {
        let entry = entry.expect("proto directory entry");
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("proto") {
            continue;
        }
        std::fs::copy(entry.path(), staging.join(entry.file_name()))
            .expect("copy proto into staging directory");
    }
    println!("cargo:rerun-if-changed={}", proto_dir.display());
    staging
}
