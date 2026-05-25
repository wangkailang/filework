use napi_derive::napi;

#[napi]
pub fn ping() -> String {
    "filework-native: ok".to_string()
}
