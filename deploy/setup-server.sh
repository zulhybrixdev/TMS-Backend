#!/usr/bin/env bash
# One-shot server setup for the whole Treasury System: all three tiers
# (dev / uat / prod), their MySQL databases + schema, and one Keycloak per
# tier. Ubuntu/Debian only. Run it ONCE on a fresh server.
#
#   mkdir -p /opt/tms && cd /opt/tms
#   git clone <backend-repo>  TMS-Backend
#   git clone <frontend-repo> TMS-Frontend
#   PUBLIC_HOST=<server IP or hostname> bash TMS-Backend/deploy/setup-server.sh
#
# Optional env: TWELVEDATA_API_KEY (live FX rates), KC_VERSION (default below),
#               FORCE=1 (re-run after a previous run - regenerates secrets!).
#
# What lives OUTSIDE the two git repos and is generated here, under the same
# parent folder: backend -> TMS-Backend and frontend -> TMS-Frontend symlinks
# (the server serves the built site from ../../frontend/dist), keycloak/, and
# ecosystem.config.cjs (the pm2 process list).
#
# Ports: dev 2417 (API) + 3417 (Vite dev server / Platform Console),
#        uat 4417, prod 5417, Keycloak 8080 / 8081 / 8082.
#
# Everything is plain HTTP - put a TLS reverse proxy in front before real
# use (see the notes printed at the end).
set -euo pipefail

KC_VERSION="${KC_VERSION:-26.7.4}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACK="$ROOT/TMS-Backend"
FRONT="$ROOT/TMS-Frontend"
KC_DIR="$ROOT/keycloak"
SECRETS="$ROOT/.tms-secrets"
MARKER="$ROOT/.tms-setup-done"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# URL-safe random string of length $1 (node is installed before first use).
rand() { node -e "console.log(require('crypto').randomBytes(96).toString('base64url').slice(0,$1))"; }

preflight() {
  [[ -n "${PUBLIC_HOST:-}" ]] || die "Set PUBLIC_HOST to this server's IP or hostname, e.g. PUBLIC_HOST=203.0.113.10"
  command -v apt-get >/dev/null || die "This script supports Ubuntu/Debian (apt) only."
  [[ -d "$BACK" && -d "$FRONT" ]] || die "Expected $BACK and $FRONT (git clone both repos into the same folder first)."
  [[ ! -f "$MARKER" || "${FORCE:-}" == "1" ]] || die "Already set up ($MARKER exists). Re-running regenerates every secret; set FORCE=1 only if you mean that."
  [[ $EUID -ne 0 ]] || die "Run as a normal user with sudo, not as root (pm2 should not run as root)."
  sudo -v
}

install_packages() {
  say "Installing packages (MySQL, Java 17 for Keycloak, Node 22, pm2)"
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates gnupg openssl unzip build-essential openjdk-17-jre-headless mysql-server
  if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  sudo npm install -g pm2
  sudo systemctl enable --now mysql
}

setup_layout() {
  say "Layout: backend/frontend symlinks"
  ln -sfn TMS-Backend "$ROOT/backend"
  ln -sfn TMS-Frontend "$ROOT/frontend"
  mkdir -p "$KC_DIR"
  : > "$SECRETS"; chmod 600 "$SECRETS"
}

# MySQL: one app user for the three app databases (+ shadow DBs used by
# `prisma migrate dev`), and one least-privilege user per Keycloak database.
setup_databases() {
  say "MySQL databases and users"
  TMS_DB_PASS="$(rand 28)"; KC_DEV_DB_PASS="$(rand 28)"; KC_UAT_DB_PASS="$(rand 28)"; KC_PROD_DB_PASS="$(rand 28)"
  sudo mysql <<SQL
CREATE DATABASE IF NOT EXISTS tms_dev CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS tms_dev_shadow CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS tms CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS tms_shadow CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS tms_production CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS keycloak CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS keycloak_uat CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS keycloak_production CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'tms'@'localhost' IDENTIFIED BY '$TMS_DB_PASS';
ALTER USER 'tms'@'localhost' IDENTIFIED BY '$TMS_DB_PASS';
GRANT ALL PRIVILEGES ON \`tms_dev\`.* TO 'tms'@'localhost';
GRANT ALL PRIVILEGES ON \`tms_dev_shadow\`.* TO 'tms'@'localhost';
GRANT ALL PRIVILEGES ON \`tms\`.* TO 'tms'@'localhost';
GRANT ALL PRIVILEGES ON \`tms_shadow\`.* TO 'tms'@'localhost';
GRANT ALL PRIVILEGES ON \`tms_production\`.* TO 'tms'@'localhost';
CREATE USER IF NOT EXISTS 'keycloak'@'localhost' IDENTIFIED BY '$KC_DEV_DB_PASS';
ALTER USER 'keycloak'@'localhost' IDENTIFIED BY '$KC_DEV_DB_PASS';
GRANT ALL PRIVILEGES ON \`keycloak\`.* TO 'keycloak'@'localhost';
CREATE USER IF NOT EXISTS 'keycloak_uat'@'localhost' IDENTIFIED BY '$KC_UAT_DB_PASS';
ALTER USER 'keycloak_uat'@'localhost' IDENTIFIED BY '$KC_UAT_DB_PASS';
GRANT ALL PRIVILEGES ON \`keycloak_uat\`.* TO 'keycloak_uat'@'localhost';
CREATE USER IF NOT EXISTS 'keycloak_prod'@'localhost' IDENTIFIED BY '$KC_PROD_DB_PASS';
ALTER USER 'keycloak_prod'@'localhost' IDENTIFIED BY '$KC_PROD_DB_PASS';
GRANT ALL PRIVILEGES ON \`keycloak_production\`.* TO 'keycloak_prod'@'localhost';
FLUSH PRIVILEGES;
SQL
}

# write_backend_env <file> <tier label> <api port> <public site port> <keycloak port> <node env> <deploy env|''> <db> <shadow db>
write_backend_env() {
  local file="$1" tier="$2" port="$3" site="$4" kcport="$5" nodeenv="$6" deployenv="$7" db="$8" shadow="$9"
  {
    echo "DATABASE_URL=\"mysql://tms:$TMS_DB_PASS@localhost:3306/$db\""
    echo "SHADOW_DATABASE_URL=\"mysql://tms:$TMS_DB_PASS@localhost:3306/$shadow\""
    echo "PORT=$port"
    echo "NODE_ENV=$nodeenv"
    echo "CORS_ORIGIN=http://$PUBLIC_HOST:$site"
    echo "APP_URL=http://$PUBLIC_HOST:$site"
    echo "JWT_SECRET=\"$(rand 64)\""
    echo "JWT_EXPIRES_IN=\"8h\""
    echo "BCRYPT_SALT_ROUNDS=10"
    echo "FIUU_ENVIRONMENT=sandbox"
    echo "TWELVEDATA_API_KEY=${TWELVEDATA_API_KEY:-}"
    [[ -z "$deployenv" ]] || echo "DEPLOY_ENV=$deployenv"
    echo "TIER_LABEL=$tier"
    echo "MFA_ENCRYPTION_KEY=\"$(rand 43)\""
    echo "PLATFORM_CONSOLE_ORIGIN=http://$PUBLIC_HOST:3417"
    echo "KEYCLOAK_URL=\"http://$PUBLIC_HOST:$kcport\""
    echo "KEYCLOAK_REALM=\"treasury-system\""
    echo "KEYCLOAK_REDIRECT_URI=\"http://$PUBLIC_HOST:$port/api/auth/sso/callback\""
  } > "$BACK/$file"
  chmod 600 "$BACK/$file"
}

write_env_files() {
  say "Environment files (fresh random secrets)"
  #               file              tier   api   site  kc    node         deploy      db              shadow
  write_backend_env .env.development DEV   2417  3417  8080  development  uat         tms_dev         tms_dev_shadow
  write_backend_env .env             UAT   4417  4417  8081  production   ""          tms             tms_shadow
  write_backend_env .env.production  PROD  5417  5417  8082  production   production  tms_production  tms_shadow
  cat > "$FRONT/.env" <<EOF
VITE_API_BASE_URL=/api
VITE_ENABLE_PLATFORM=true
VITE_ENABLE_BILLING=true
VITE_PLATFORM_UAT_API_BASE=http://$PUBLIC_HOST:4417/api
VITE_PLATFORM_PROD_API_BASE=http://$PUBLIC_HOST:5417/api
EOF
}

# Prisma applies every migration in prisma/migrations = the full DB schema.
migrate_and_seed() {
  say "Backend: install, build, create the schema in all three databases, seed"
  cd "$BACK"
  npm ci
  npx prisma generate
  npm run build
  local envfile
  for envfile in .env.development .env .env.production; do
    echo "--- prisma migrate deploy ($envfile)"
    ( set -a; . "./$envfile"; set +a; npx prisma migrate deploy )
  done
  # dev/uat are demo tiers: the documented demo tenant + users (the login page
  # advertises password Password123!) - keep them off the public internet.
  npm run seed
  npm run seed:uat
  # prod: NO demo tenant/users - only the platform admin, with a random password.
  PROD_ADMIN_PW="$(rand 20)"
  SEED_PLATFORM_ADMIN_ONLY=true SEED_DEMO_PASSWORD="$PROD_ADMIN_PW" npm run seed:production
}

build_frontend() {
  say "Frontend: install and build the full app and the /poc app"
  cd "$FRONT"
  npm ci
  npm run build
  npm run build:poc
}

install_keycloak() {
  say "Keycloak $KC_VERSION (one instance per tier; prod gets its own copy of the binary)"
  cd "$KC_DIR"
  if [[ ! -d "keycloak-$KC_VERSION" ]]; then
    curl -fL -o kc.tar.gz "https://github.com/keycloak/keycloak/releases/download/$KC_VERSION/keycloak-$KC_VERSION.tar.gz"
    tar -xzf kc.tar.gz && rm kc.tar.gz
  fi
  [[ -d "keycloak-$KC_VERSION-prod" ]] || cp -r "keycloak-$KC_VERSION" "keycloak-$KC_VERSION-prod"

  local tier port db user pass
  for spec in "dev 8080 keycloak keycloak $KC_DEV_DB_PASS" "uat 8081 keycloak_uat keycloak_uat $KC_UAT_DB_PASS" "prod 8082 keycloak_production keycloak_prod $KC_PROD_DB_PASS"; do
    read -r tier port db user pass <<<"$spec"
    cat > ".env.$tier" <<EOF
KC_DB=mysql
KC_DB_URL=jdbc:mysql://localhost:3306/$db
KC_DB_USERNAME=$user
KC_DB_PASSWORD=$pass
KC_BOOTSTRAP_ADMIN_USERNAME=admin
KC_BOOTSTRAP_ADMIN_PASSWORD=$(rand 24)
KC_HTTP_PORT=$port
EOF
    chmod 600 ".env.$tier"
  done

  for tier in dev uat; do
    cat > "start-$tier.sh" <<EOF
#!/bin/bash
set -a; . "\$(dirname "\$0")/.env.$tier"; set +a
exec "\$(dirname "\$0")/keycloak-$KC_VERSION/bin/kc.sh" start-dev
EOF
  done
  cat > start-prod.sh <<EOF
#!/bin/bash
# Real Keycloak production mode (build + start --optimized), own binary copy.
# HTTP only for now - see the TLS note in deploy/setup-server.sh.
set -a; . "\$(dirname "\$0")/.env.prod"; set +a
KC="\$(dirname "\$0")/keycloak-$KC_VERSION-prod/bin/kc.sh"
"\$KC" build --db=mysql
exec "\$KC" start --http-enabled=true --hostname-strict=false --optimized
EOF
  chmod +x start-dev.sh start-uat.sh start-prod.sh
}

write_ecosystem() {
  say "pm2 process list"
  cat > "$ROOT/ecosystem.config.cjs" <<'EOF'
// Generated by TMS-Backend/deploy/setup-server.sh - all tiers on one host.
module.exports = {
  apps: [
    { name: "keycloak-dev", cwd: "./keycloak", script: "./start-dev.sh", interpreter: "none" },
    { name: "keycloak-uat", cwd: "./keycloak", script: "./start-uat.sh", interpreter: "none" },
    { name: "keycloak-prod", cwd: "./keycloak", script: "./start-prod.sh", interpreter: "none" },
    { name: "tms-backend-dev", cwd: "./TMS-Backend", script: "npm", args: "run dev" },
    // Vite dev server: also serves the Platform Console. --host so it is reachable off-box.
    { name: "tms-frontend-dev", cwd: "./TMS-Frontend", script: "npm", args: "run dev -- --host 0.0.0.0" },
    { name: "tms-backend-uat", cwd: "./TMS-Backend", script: "dist/index.js" },
    { name: "tms-backend-prod", cwd: "./TMS-Backend", script: "dist/index.js", env: { DOTENV_CONFIG_PATH: ".env.production" } },
  ],
};
EOF
}

# ---- Keycloak admin REST helpers (talk to the local instance directly) ----
kc_token() { # port password
  curl -fsS -X POST "http://localhost:$1/realms/master/protocol/openid-connect/token" \
    -d client_id=admin-cli -d username=admin -d "password=$2" -d grant_type=password |
    node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).access_token"
}
kc_get() { curl -fsS -H "Authorization: Bearer $KC_T" "http://localhost:$KC_PORT/admin/realms$1"; }
kc_send() { curl -fsS -o /dev/null -X "$1" -H "Authorization: Bearer $KC_T" -H "Content-Type: application/json" "http://localhost:$KC_PORT/admin/realms$2" -d "$3"; }
jq_() { node -pe "const j=JSON.parse(require('fs').readFileSync(0,'utf8')); $1"; }

wait_for_keycloak() { # port
  local i
  for i in $(seq 1 90); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$1/realms/master" || true)" == "200" ]] && return 0
    sleep 3
  done
  die "Keycloak on :$1 did not come up - check 'pm2 logs keycloak-*'"
}

# provision_keycloak <tier> <keycloak port> <backend env file> <backend api port>
provision_keycloak() {
  local tier="$1" kcport="$2" envfile="$3" apiport="$4"
  KC_PORT="$kcport"
  local pw; pw="$(grep '^KC_BOOTSTRAP_ADMIN_PASSWORD=' "$KC_DIR/.env.$tier" | cut -d= -f2)"
  say "Keycloak $tier: realm, SSO client, platform service account"
  KC_T="$(kc_token "$kcport" "$pw")"

  # sslRequired defaults to "external", which rejects plain-HTTP access via a
  # public IP/hostname ("HTTPS required"). "none" is for the HTTP-only phase.
  kc_send PUT /master '{"sslRequired":"none"}'
  kc_send POST "" '{"realm":"treasury-system","enabled":true,"displayName":"Treasury System","sslRequired":"none"}'

  # The client the backend uses for the SSO login flow (PKCE enforced).
  local sso_secret; sso_secret="$(rand 32)"
  kc_send POST /treasury-system/clients "{\"clientId\":\"tms-backend\",\"enabled\":true,\"protocol\":\"openid-connect\",\"publicClient\":false,\"clientAuthenticatorType\":\"client-secret\",\"secret\":\"$sso_secret\",\"redirectUris\":[\"http://$PUBLIC_HOST:$apiport/api/auth/sso/callback\"],\"standardFlowEnabled\":true,\"directAccessGrantsEnabled\":false,\"attributes\":{\"pkce.code.challenge.method\":\"S256\"}}"

  # Least-privilege service account for the Platform Console (identity providers only).
  KC_T="$(kc_token "$kcport" "$pw")"
  kc_send POST /treasury-system/clients '{"clientId":"tms-platform-admin","enabled":true,"publicClient":false,"serviceAccountsEnabled":true,"standardFlowEnabled":false,"directAccessGrantsEnabled":false,"clientAuthenticatorType":"client-secret"}'
  local uuid sa rm roles admin_secret
  uuid="$(kc_get '/treasury-system/clients?clientId=tms-platform-admin' | jq_ 'j[0].id')"
  sa="$(kc_get "/treasury-system/clients/$uuid/service-account-user" | jq_ 'j.id')"
  rm="$(kc_get '/treasury-system/clients?clientId=realm-management' | jq_ 'j[0].id')"
  roles="$(kc_get "/treasury-system/clients/$rm/roles" | jq_ "JSON.stringify(j.filter(r=>['manage-identity-providers','view-identity-providers','view-realm'].includes(r.name)))")"
  kc_send POST "/treasury-system/users/$sa/role-mappings/clients/$rm" "$roles"
  admin_secret="$(kc_get "/treasury-system/clients/$uuid/client-secret" | jq_ 'j.value')"

  # Names optional: a bare SAML assertion carries only an email, and Keycloak's
  # default profile would stop every first-time SSO user on a form.
  local relax_js='j.attributes.forEach(a=>{ if(["firstName","lastName"].includes(a.name)) delete a.required; }); JSON.stringify(j)'
  local profile; profile="$(kc_get /treasury-system/users/profile | jq_ "$relax_js")"
  kc_send PUT /treasury-system/users/profile "$profile"

  {
    echo "KEYCLOAK_CLIENT_ID=\"tms-backend\""
    echo "KEYCLOAK_CLIENT_SECRET=\"$sso_secret\""
    echo "KEYCLOAK_ADMIN_CLIENT_ID=\"tms-platform-admin\""
    echo "KEYCLOAK_ADMIN_CLIENT_SECRET=\"$admin_secret\""
  } >> "$BACK/$envfile"
}

start_everything() {
  cd "$ROOT"
  say "Starting Keycloak (first boot takes a minute or two)"
  pm2 start ecosystem.config.cjs --only keycloak-dev,keycloak-uat,keycloak-prod
  wait_for_keycloak 8080; wait_for_keycloak 8081; wait_for_keycloak 8082
  provision_keycloak dev  8080 .env.development 2417
  provision_keycloak uat  8081 .env             4417
  provision_keycloak prod 8082 .env.production  5417

  say "Starting the app tiers"
  pm2 start ecosystem.config.cjs --only tms-backend-dev,tms-frontend-dev,tms-backend-uat,tms-backend-prod
  pm2 save
  say "Making pm2 start on boot"
  sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME"
  pm2 save
}

write_summary() {
  {
    echo "Treasury System - server secrets (keep private)"
    echo "Production platform admin:  platform-admin@treasurysystem.com.my  /  $PROD_ADMIN_PW"
    echo "dev + uat demo logins use the documented demo password (Password123!) - do not expose them publicly."
    echo "Keycloak admin (master realm), username admin - passwords are in:"
    echo "  $KC_DIR/.env.dev   $KC_DIR/.env.uat   $KC_DIR/.env.prod   (KC_BOOTSTRAP_ADMIN_PASSWORD)"
    echo "App database/JWT/MFA secrets are in the .env* files under $BACK (mode 600)."
  } > "$SECRETS"
  touch "$MARKER"
  cat <<EOF

$(printf '\033[1;32m')Setup complete.$(printf '\033[0m')

  Production app        http://$PUBLIC_HOST:5417      Keycloak admin  http://$PUBLIC_HOST:8082/admin
  UAT (+ /poc)          http://$PUBLIC_HOST:4417                      http://$PUBLIC_HOST:8081/admin
  Dev app               http://$PUBLIC_HOST:3417                      http://$PUBLIC_HOST:8080/admin
  Platform Console      http://$PUBLIC_HOST:3417/platform/login   (manages uat + prod)

  Secrets summary:      cat $SECRETS
  Processes:            pm2 list        Logs: pm2 logs <name>

Before real use:
  1. Firewall: expose only what users need (prod :5417, its Keycloak :8082). Keep dev
     :2417/:3417/:8080 and uat :4417/:8081 private - they have demo logins.
  2. Put a TLS reverse proxy (Caddy/nginx) in front, then switch APP_URL/CORS_ORIGIN/
     KEYCLOAK_URL to https URLs and set the Keycloak realms' sslRequired back to "external".
  3. Replace the temporary Keycloak 'admin' accounts with named admins.
  4. Add FIUU_* (payments) and TWELVEDATA_API_KEY (live FX) to the env files if used,
     then: pm2 restart all
EOF
}

main() {
  preflight
  install_packages
  setup_layout
  setup_databases
  write_env_files
  migrate_and_seed
  build_frontend
  install_keycloak
  write_ecosystem
  start_everything
  write_summary
}

# Allow `source`-ing for tests without running.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
