#!/bin/sh
# Gera o certificado HTTPS autoassinado do switchboard para um IP (ou domínio).
#
# Uso:  sh deploy/gerar-certificado.sh 203.0.113.10
#
# Usa um arquivo de configuração próprio em vez de "openssl req -addext": no OpenSSL 1.1.1
# (Rocky Linux 8 / Issabel 5) o -addext soma as extensões padrão do sistema e o certificado sai
# com extensões duplicadas, que o Chrome rejeita com ERR_CERT_INVALID.
set -eu

ALVO="${1:-}"
if [ -z "$ALVO" ]; then
  echo "Uso: sh $0 <IP-publico-ou-dominio>" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$DIR"

# IP vira "IP:", domínio vira "DNS:"
if echo "$ALVO" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then SAN="IP:$ALVO"; else SAN="DNS:$ALVO"; fi

CNF="$(mktemp)"
trap 'rm -f "$CNF"' EXIT
cat > "$CNF" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = $ALVO
O = Intek Telecomunicacoes

[ext]
subjectAltName = $SAN
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 825 -sha256 -config "$CNF" \
  -keyout "$DIR/switchboard.key" -out "$DIR/switchboard.crt" 2>/dev/null

chmod 600 "$DIR/switchboard.key"
chmod 644 "$DIR/switchboard.crt"
if id switchboard >/dev/null 2>&1; then chown -R switchboard:switchboard "$DIR"; fi

# Conferência: cada extensão deve aparecer uma única vez
TEXTO="$(openssl x509 -in "$DIR/switchboard.crt" -noout -text)"
for EXT in "Basic Constraints" "Key Usage" "Subject Alternative Name"; do
  N="$(echo "$TEXTO" | grep -c "X509v3 $EXT" || true)"
  if [ "$N" != "1" ]; then
    echo "ERRO: a extensão \"$EXT\" aparece $N vezes no certificado" >&2
    exit 1
  fi
done

echo "Certificado gerado em $DIR"
echo "  $(echo "$TEXTO" | grep -A1 'Subject Alternative Name' | tail -1 | sed 's/^ *//')"
echo "  válido até: $(openssl x509 -in "$DIR/switchboard.crt" -noout -enddate | cut -d= -f2)"
echo "Agora reinicie: systemctl restart switchboard"
