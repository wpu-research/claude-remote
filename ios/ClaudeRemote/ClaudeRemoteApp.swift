import SwiftUI
import WebKit
import LocalAuthentication
import Security

// Terminaller — Claude Remote panelini tam ekran açan küçük iOS uygulaması.
// İlk açılışta panel linki (token'lı) istenir, Keychain'de saklanır.
// Her açılışta ve 1 dk'dan uzun arka plandan dönüşte Touch ID / Face ID / şifre sorar.
// Telefonu sallamak ayarları açar.

let defaultURL = "https://relay-production-8f42.up.railway.app"

@main
struct ClaudeRemoteApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model).preferredColorScheme(.dark)
        }
    }
}

// MARK: - Durum

final class AppModel: ObservableObject {
    @Published var baseURL: String = UserDefaults.standard.string(forKey: "baseURL") ?? defaultURL
    @Published var token: String = Keychain.get("token") ?? ""
    @Published var locked = true
    @Published var showSettings = false
    @Published var lockEnabled: Bool = UserDefaults.standard.object(forKey: "lockEnabled") as? Bool ?? true
    @Published var reloadTick = 0
    private var backgroundedAt: Date?

    var configured: Bool { !token.isEmpty }
    var startURL: URL? {
        var c = URLComponents(string: baseURL.trimmingCharacters(in: .whitespaces))
        c?.path = "/"
        c?.queryItems = [URLQueryItem(name: "token", value: token)]
        return c?.url
    }

    /// Tam link (…/?token=…) ya da yalnız token kabul eder.
    func save(link: String) -> Bool {
        let s = link.trimmingCharacters(in: .whitespacesAndNewlines)
        if let c = URLComponents(string: s), let t = c.queryItems?.first(where: { $0.name == "token" })?.value,
           let scheme = c.scheme, let host = c.host, !t.isEmpty {
            baseURL = "\(scheme)://\(host)"
            token = t
        } else if s.count >= 20, !s.contains(" "), !s.contains("/") {
            token = s
        } else {
            return false
        }
        UserDefaults.standard.set(baseURL, forKey: "baseURL")
        Keychain.set("token", token)
        locked = false
        reloadTick += 1
        return true
    }

    func reset() {
        token = ""
        Keychain.set("token", "")
        showSettings = false
    }

    func setLock(_ on: Bool) {
        lockEnabled = on
        UserDefaults.standard.set(on, forKey: "lockEnabled")
    }

    func didEnterBackground() { backgroundedAt = Date() }
    func willEnterForeground() {
        if let t = backgroundedAt, Date().timeIntervalSince(t) > 60, lockEnabled { locked = true }
        backgroundedAt = nil
    }

    func unlock() {
        guard lockEnabled else { locked = false; return }
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { locked = false; return }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Terminallere giriş") { ok, _ in
            DispatchQueue.main.async { if ok { self.locked = false } }
        }
    }
}

// MARK: - Ekranlar

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var phase

    var body: some View {
        ZStack {
            Color(red: 0.05, green: 0.07, blue: 0.09).ignoresSafeArea()
            if !model.configured {
                SetupView()
            } else {
                WebView().ignoresSafeArea()
                if model.locked && model.lockEnabled { LockView() }
            }
        }
        .onAppear { if model.configured { model.unlock() } }
        .onChange(of: phase) { p in
            if p == .background { model.didEnterBackground() }
            if p == .active {
                model.willEnterForeground()
                if model.locked && model.configured { model.unlock() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .deviceDidShake)) { _ in
            if model.configured { model.showSettings = true }
        }
        .sheet(isPresented: $model.showSettings) { SettingsView() }
    }
}

struct SetupView: View {
    @EnvironmentObject var model: AppModel
    @State private var link = ""
    @State private var error = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(">_").font(.system(size: 54, weight: .bold, design: .monospaced))
                .foregroundColor(Color(red: 0.85, green: 0.47, blue: 0.34))
            Text("Terminaller").font(.largeTitle.bold())
            Text("Laptoptaki panelin token'lı linkini kopyala, aşağıdaki düğmeye bas.")
                .foregroundColor(.secondary)
            Button {
                link = UIPasteboard.general.string ?? ""
                error = !model.save(link: link)
            } label: {
                Label("Panodaki linki kullan", systemImage: "doc.on.clipboard")
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent).tint(Color(red: 0.85, green: 0.47, blue: 0.34))
            Text("ya da elle yapıştır").font(.footnote).foregroundColor(.secondary)
            TextField("https://…/?token=…", text: $link)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(10).background(Color.white.opacity(0.06)).cornerRadius(8)
                .onSubmit { error = !model.save(link: link) }
            if error { Text("Link tanınmadı. Tam linki (…?token=…) yapıştır.").foregroundColor(.red).font(.footnote) }
            Spacer()
        }
        .padding(24)
    }
}

struct LockView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        ZStack {
            Color(red: 0.05, green: 0.07, blue: 0.09).ignoresSafeArea()
            VStack(spacing: 18) {
                Image(systemName: "lock.fill").font(.system(size: 44)).foregroundColor(.secondary)
                Button("Kilidi aç") { model.unlock() }.buttonStyle(.borderedProminent)
                    .tint(Color(red: 0.85, green: 0.47, blue: 0.34))
            }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        NavigationView {
            Form {
                Section(footer: Text("Ayarları açmak için telefonu salla.")) {
                    Toggle("Touch ID / şifre kilidi", isOn: Binding(get: { model.lockEnabled }, set: { model.setLock($0) }))
                    Button("Sayfayı yenile") { model.reloadTick += 1; model.showSettings = false }
                }
                Section(header: Text("Bağlantı"), footer: Text(model.baseURL)) {
                    Button("Linki değiştir", role: .destructive) { model.reset() }
                }
            }
            .navigationTitle("Ayarlar")
            .toolbar { Button("Kapat") { model.showSettings = false } }
        }
    }
}

// MARK: - Web görünümü

struct WebView: UIViewRepresentable {
    @EnvironmentObject var model: AppModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.allowsInlineMediaPlayback = true
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.05, green: 0.07, blue: 0.09, alpha: 1)
        web.scrollView.backgroundColor = web.backgroundColor
        web.scrollView.contentInsetAdjustmentBehavior = .never   // sayfa safe-area'yı CSS ile kendisi ayarlıyor
        web.allowsBackForwardNavigationGestures = true
        web.navigationDelegate = context.coordinator
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.pull(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh
        context.coordinator.web = web
        context.coordinator.loadStart()
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if context.coordinator.tick != model.reloadTick {
            context.coordinator.tick = model.reloadTick
            context.coordinator.loadStart()
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let model: AppModel
        weak var web: WKWebView?
        var tick = 0
        init(model: AppModel) { self.model = model; tick = model.reloadTick }

        func loadStart() {
            guard let url = model.startURL else { return }
            web?.load(URLRequest(url: url))
        }

        @objc func pull(_ sender: UIRefreshControl) {
            web?.reload()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { sender.endRefreshing() }
        }

        // Panel dışındaki linkler Safari'de açılsın
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = action.request.url, let host = url.host,
               host != URL(string: model.baseURL)?.host, action.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        // Token geçersizse kurulum ekranına dön
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if let r = response.response as? HTTPURLResponse, r.statusCode == 401, response.isForMainFrame {
                DispatchQueue.main.async { self.model.reset() }
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
            let html = """
            <meta name="viewport" content="width=device-width"><body style="font:17px -apple-system;background:#0d1117;color:#c9d1d9;padding:60px 24px">
            <h3>Bağlanılamadı</h3><p>\(error.localizedDescription)</p><p>İnternetini kontrol et, sonra aşağı çekip yenile.</p>
            """
            webView.loadHTMLString(html, baseURL: nil)
        }
    }
}

// MARK: - Sallama algılama

extension Notification.Name { static let deviceDidShake = Notification.Name("deviceDidShake") }
extension UIWindow {
    open override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake { NotificationCenter.default.post(name: .deviceDidShake, object: nil) }
        super.motionEnded(motion, with: event)
    }
}

// MARK: - Keychain

enum Keychain {
    static func set(_ key: String, _ value: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
        guard !value.isEmpty else { return }
        var add = q
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
    static func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
