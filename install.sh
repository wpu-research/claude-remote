#!/usr/bin/env bash
# Claude Remote kurulumu: systemd kullanıcı servisi + tmux ayarı + terminalleri otomatik tmux'a alma.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

command -v tmux >/dev/null || { echo "Önce tmux kur: sudo apt install -y tmux"; exit 1; }

# 1) tmux ayarı (varsa dokunma)
if [ ! -f ~/.tmux.conf ]; then
  cat > ~/.tmux.conf <<'EOF'
set -g mouse on
set -g history-limit 50000
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",*256col*:Tc"
set -g status-style "bg=#161b22,fg=#8b949e"
EOF
  echo "~/.tmux.conf yazıldı"
fi

# 2) Her yeni GNOME Terminal penceresi tmux içinde açılsın (telefondan görünsün)
MARK="# >>> claude-remote auto-tmux >>>"
if ! grep -qF "$MARK" ~/.bashrc; then
  cat >> ~/.bashrc <<'EOF'
# >>> claude-remote auto-tmux >>>
if [[ $- == *i* && -z "$TMUX" && -n "$VTE_VERSION" && -z "$SSH_TTY" && -z "$NO_TMUX" ]] && command -v tmux >/dev/null; then
  exec tmux new-session -c "$PWD"
fi
# <<< claude-remote auto-tmux <<<
EOF
  echo "~/.bashrc'ye auto-tmux eklendi (kapatmak için: NO_TMUX=1 veya bloğu sil)"
fi

# 3) Servis
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/claude-remote.service <<EOF
[Unit]
Description=Claude Remote (tmux web panel)
After=network-online.target

[Service]
ExecStart=$(command -v node) $DIR/server.js
Restart=always
RestartSec=3
Environment=PATH=$PATH

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now claude-remote.service
sleep 1
journalctl --user -u claude-remote -n 3 --no-pager -o cat | grep -m1 'http' || systemctl --user status claude-remote --no-pager
