import Foundation
import Security

/// Optional access token for a public edge (e.g. an nginx in front of the server that checks
/// `Authorization: Bearer <token>`). Stored in the Keychain, never in UserDefaults. Empty = no header
/// (plain LAN servers don't need one).
enum AccessToken {
    private static let service = "com.wilddolphin.parakeetkaraoke.server"
    private static let account = "accessToken"
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static var value: String {
        get {
            var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return "" }
            return String(decoding: d, as: UTF8.self)
        }
        set {
            let t = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            SecItemDelete(query as CFDictionary)
            guard !t.isEmpty else { return }
            var q = query
            q[kSecValueData as String] = Data(t.utf8)
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(q as CFDictionary, nil)
        }
    }
}
