# Claude Remote

iPhone 8 (iOS 16) Safari'den laptop'taki tüm terminalleri canlı izleme/yönetme paneli.
tmux + bağımlılıksız Node sunucusu, yalnız Tailscale IP'sine bind olur, token'lı.

## Kurulum
    sudo apt install -y tmux
    ./install.sh

Adres + token: `journalctl --user -u claude-remote -o cat | grep http`
(Token: `~/.config/claude-remote/token`.) Sabit adres: `http://wpu-thinkpad-e15.tail2a8949.ts.net:7681/?token=...`.
Linki iPhone'da bir kez aç → Paylaş → Ana Ekrana Ekle. Token adreste kalır (iOS ana ekran uygulaması
Safari cookie'lerini görmez), ikon `public/icon.png`.

## Ne yapar
- Claude: laptoptaki tüm Claude oturumları (açık + kapalı, `~/.claude/projects` kayıtlarından),
  sohbet görünümü, durum (çalışıyor / seni bekliyor / kapalı). Kapalıysa "Kaldığı yerden devam et"
  (`claude --resume` tmux'ta açılır); laptopta açıksa izle veya "Devral"
- Oturumlar: tüm tmux pane'leri, canlı ekran (renkli), yazı gönderme, Esc/^C/ok/1-2-3/y-n tuşları
- Projeler: `~/Desktop/Urunler`, `~/Downloads/Projects`, `~/Desktop` altındaki projelerde
  tek tuşla `claude`, `claude --continue` ya da shell başlatma
- install.sh, yeni GNOME Terminal pencerelerini otomatik tmux içinde açar (`NO_TMUX=1` ile atla)

Ayarlar (env): `PORT` (7681), `HOST` (tailscale IP), `PROJECT_ROOTS` (`:` ayrımlı).

## İnternetten erişim (Railway relay)
- Site: https://relay-production-8f42.up.railway.app/?token=<webToken>  (token: `~/.config/claude-remote/relay.json`)
- Railway projesi `claude-remote`, servis `relay` (`relay/`, `railway up` ile yüklenir; env `WEB_TOKEN`, `AGENT_SECRET`).
- Laptopta `claude-remote-agent` systemd servisi (`agent/agent.js`) relay'e dışarı doğru WebSocket açar,
  istekleri 127.0.0.1:7681'e iletir. Laptopta port açılmaz. Laptop kapalıyken site "çevrimdışı" der.
- Token'ı değiştirmek: relay.json'daki webToken'ı değiştir + `railway variables --set WEB_TOKEN=...` (relay/ içinde).
