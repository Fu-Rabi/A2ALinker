#!/bin/bash
# A2ALinker - Security Configuration Script
# Run this script with sudo on the deployment relay node explicitly.

set -e

echo "🔒 Commencing A2ALinker Strict OS Hardening..."

# 1. Process Isolation (Create a2a-runner user)
if ! id -u a2a-runner >/dev/null 2>&1; then
    echo "=> Creating isolated runner user (a2a-runner)..."
    sudo useradd -r -s /bin/false a2a-runner
else
    echo "=> Runner user (a2a-runner) already exists."
fi

# Set restrictive permission limits over project repository
# Ensure you are running this in the A2ALinker deployment directory!
DIR=$(pwd)
echo "=> Restricting permissions on deployment directory ($DIR)..."
sudo chown -R a2a-runner:a2a-runner "$DIR"
sudo chmod -R 700 "$DIR"
if [ -f "linker.db" ]; then
    sudo chmod 600 linker.db
fi

# 2. Strict Firewall (UFW)
echo "=> Re-configuring Uncomplicated Firewall (UFW)..."
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp     # Admin OpenSSH
sudo ufw allow 2222/tcp   # A2ALinker Agent Rendezvous
sudo ufw allow 443/tcp    # HTTPS API (agents connect here)
sudo ufw allow 80/tcp     # Let's Encrypt cert renewal (required for certbot HTTP challenge)
sudo ufw --force enable

# 3. Disable Password Auth for Admin SSH
# IMPORTANT: We cannot rely on grepping for 'PasswordAuthentication yes' — many
# Linux distributions leave the line commented out or absent, defaulting to 'yes'.
# The safe approach is to force-inject both the setting and the override.
echo "=> Hardening OS OpenSSH rules (/etc/ssh/sshd_config)..."
# Strip any existing PasswordAuthentication lines (commented or not)
sudo sed -i '/^#\?PasswordAuthentication/d' /etc/ssh/sshd_config
# Append the explicit deny at the bottom (takes precedence)
echo 'PasswordAuthentication no' | sudo tee -a /etc/ssh/sshd_config > /dev/null
sudo systemctl restart ssh || sudo systemctl restart sshd
echo "=> Password Authentication explicitly disabled."

# Allow a2a-runner to bind port 443 without root
echo "=> Configuring authbind for port 443..."
sudo apt-get install -y authbind > /dev/null
sudo touch /etc/authbind/byport/443
sudo chown a2a-runner /etc/authbind/byport/443
sudo chmod 500 /etc/authbind/byport/443

# Setup Systemd File
echo "=> Installing restricted systemd service..."
sudo cp "$DIR/scripts/a2a-linker.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable a2a-linker
echo "=> Done! Start the broker via: sudo systemctl start a2a-linker"
