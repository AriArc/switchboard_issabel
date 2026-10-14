# Telefone no navegador (WebRTC) — opcional

Este modo **não é o padrão**. Use quando o cliente **não tem telefone IP nem quer softphone**: o próprio
switchboard vira o telefone do ramal. Ele toca e atende ligações, liga clicando nos ramais e tem mudo,
espera, teclado (DTMF) e desligar, tudo no navegador, com fone de ouvido e microfone do computador.

Quem já usa telefone IP ou softphone não precisa de nada disto. Com `WEBRTC_ENABLED` desligado (padrão)
o switchboard funciona exatamente como antes.

## Como funciona

```
 Navegador (JsSIP) ══ HTTPS/WSS :8443 ══▶ switchboard ── ws://127.0.0.1:8088/ws ──▶ Asterisk (PJSIP)
        ▲                                                                              │
        └──────────── áudio (SRTP, UDP 10000–20000) direto com o Asterisk ─────────────┘
```

- A sinalização SIP vai do navegador para o switchboard, na **mesma porta 8443**, e o switchboard repassa
  para o WebSocket do Asterisk na própria VPS. A porta 8088 do Asterisk **não** é aberta para a internet.
- O switchboard só deixa passar usuários logados, com a opção WebRTC no cadastro, e só para o
  **próprio ramal**. Uma tentativa de registrar ou ligar como outro ramal derruba a conexão.
- O áudio vai direto entre o navegador e o Asterisk, criptografado (DTLS-SRTP).
- Com o telefone do navegador registrado, o click-to-call liga **direto do navegador**, sem tocar o ramal
  antes.

## Requisitos

- **HTTPS no switchboard.** O navegador só libera o microfone em páginas HTTPS. Sem domínio, use um
  certificado autoassinado para o IP (passo 1). Os usuários passam a acessar `https://<IP>:8443`.
- Asterisk com PJSIP (o Issabel 5 já tem).
- Portas **UDP 10000–20000** (RTP) liberadas no firewall, como já é necessário para telefones IP.
- Navegador atualizado (Chrome, Edge ou Firefox) e fone de ouvido com microfone.

## 1. Certificado HTTPS para o IP público

Troque `203.0.113.10` pelo IP público da VPS:

```bash
mkdir -p /opt/switchboard_issabel/certs && cd /opt/switchboard_issabel/certs
IP=203.0.113.10
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -subj "/CN=$IP/O=Intek Telecomunicacoes" \
  -addext "subjectAltName=IP:$IP" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  -keyout switchboard.key -out switchboard.crt
chown -R switchboard:switchboard /opt/switchboard_issabel/certs
chmod 600 switchboard.key
```

O navegador mostra um aviso de certificado. Cada usuário pode clicar em **Avançado → Continuar para o
site** uma vez, ou você pode instalar o `switchboard.crt` nos computadores como confiável e o aviso some.
No **Windows** (Chrome/Edge): dois cliques no arquivo → *Instalar Certificado* → *Máquina Local* →
*Autoridades de Certificação Raiz Confiáveis*, e depois reinicie o navegador.

## 2. Asterisk do Issabel

Os arquivos `*_custom*.conf` abaixo são os pontos de personalização padrão (não são sobrescritos pela
interface do Issabel). Antes de editar, confira quais o seu Asterisk inclui:

```bash
grep -h "#include\|#tryinclude" /etc/asterisk/pjsip.conf /etc/asterisk/sip.conf /etc/asterisk/http.conf 2>/dev/null
```

Se algum arquivo citado aqui não aparecer, use o que aparece com nome equivalente.

### 2.1 Servidor HTTP/WebSocket do Asterisk

```bash
asterisk -rx "http show status"
```

Deve mostrar `Server Enabled and Bound to 127.0.0.1:8088` (ou `0.0.0.0:8088`) e a linha
`/ws => Asterisk HTTP WebSocket`. Se estiver desabilitado, adicione em `/etc/asterisk/http_custom.conf`
(ou, se esse arquivo não for incluído na sua versão, em `/etc/asterisk/http.conf`, na seção `[general]`):

```ini
enabled=yes
bindaddr=127.0.0.1
bindport=8088
```

Mantenha a porta **8088 fechada** no firewall: só o switchboard, na própria VPS, acessa.

### 2.2 Desligar o WebSocket do chan_sip (importante)

O Issabel carrega os dois drivers SIP. Se o `chan_sip` estiver com WebSocket ligado, **ele captura as
conexões do navegador** e o registro falha com "senha SIP incorreta", mesmo com a senha certa. Adicione
em `/etc/asterisk/sip_general_custom.conf`:

```ini
websocket_enabled=no
```

### 2.3 Transporte WebSocket no PJSIP

```bash
asterisk -rx "pjsip show transports"
```

Se não houver um transporte com protocolo `ws`, crie em `/etc/asterisk/pjsip_custom.conf`:

```ini
[transport-ws]
type=transport
protocol=ws
bind=0.0.0.0
```

(No WebSocket o endereço `bind` é ignorado: o Asterisk usa o servidor HTTP do passo 2.1.)

### 2.4 Ramais que vão usar o navegador

Para **cada ramal** que vai usar o telefone no navegador (exemplo: 7000), em
`/etc/asterisk/pjsip.endpoint_custom_post.conf`:

```ini
[7000](+)
webrtc=yes
transport=transport-ws
```

E em `/etc/asterisk/pjsip.aor_custom_post.conf`:

```ini
[7000](+)
max_contacts=1
remove_existing=yes
```

- `webrtc=yes` liga ICE, DTLS-SRTP e as demais opções exigidas pelos navegadores.
- `transport=transport-ws` faz o Asterisk mandar as ligações para o navegador. Use o nome do transporte
  `ws` que aparece em `pjsip show transports`. Um ramal configurado assim passa a funcionar **só** no
  navegador; para voltar a um telefone IP, remova estas linhas.

### 2.5 Aplicar

```bash
asterisk -rx "core restart when convenient"
```

O reinício completo é necessário para o `chan_sip` liberar o WebSocket. Faça fora do horário de
movimento, porque derruba as ligações em andamento. Depois confira:

```bash
asterisk -rx "http show status" | grep /ws
asterisk -rx "pjsip show transports"
asterisk -rx "pjsip show endpoint 7000" | grep -E "webrtc|transport|ice_support|media_encryption"
```

### 2.6 VPS com IP público atrás de NAT

Se o IP da interface da VPS (`ip addr`) for diferente do IP público, informe o mapeamento em
`/etc/asterisk/rtp_custom.conf` (ou `rtp.conf`):

```ini
[ice_host_candidates]
10.0.0.5 => 203.0.113.10   ; IP da interface => IP público
```

Na maioria das VPS o IP público já está na interface e este passo não é necessário.

## 3. Switchboard

No `/opt/switchboard_issabel/.env`:

```ini
HTTPS_CERT_FILE=/opt/switchboard_issabel/certs/switchboard.crt
HTTPS_KEY_FILE=/opt/switchboard_issabel/certs/switchboard.key
WEBRTC_ENABLED=1
# Opcionais (valores padrão):
# WEBRTC_ASTERISK_WS=ws://127.0.0.1:8088/ws
# WEBRTC_STUN=stun:stun.l.google.com:19302
# WEBRTC_SIP_DOMAIN=
```

```bash
systemctl restart switchboard
journalctl -u switchboard -n 5   # deve mostrar "https://..." e "[webrtc] telefone no navegador habilitado"
```

Os usuários passam a acessar **`https://<IP>:8443`** (com **https**).

## 4. Cadastro dos usuários

Em **Usuários → editar**, para cada pessoa que vai usar o navegador como telefone:

1. Marque **Telefone no navegador (WebRTC)**.
2. Em **Senha SIP do ramal**, informe o *secret* do ramal no Issabel (*PBX → Extensões → ramal → secret*).
   A senha fica guardada **criptografada** no servidor e só é entregue ao navegador do próprio usuário.

> Se o `SESSION_SECRET` do `.env` for trocado, as senhas SIP cadastradas deixam de ser legíveis e precisam
> ser informadas de novo.

## 5. Uso

- No topo da tela aparece **"Telefone: ramal 7000"** em verde quando o navegador está registrado.
- Na primeira ligação o navegador pede permissão para usar o **microfone**: clique em *Permitir*.
- Ligação recebida: o painel no canto da tela toca e mostra **Atender / Recusar**, e o título da aba pisca.
- Em ligação: **Mudo**, **Espera**, **Teclado** (DTMF para URAs; as teclas do computador também funcionam)
  e **Desligar**.
- **A aba precisa ficar aberta.** Com a aba ou o navegador fechado, o ramal fica offline e as ligações
  seguem a regra do Issabel para ramal indisponível (correio de voz, siga-me etc.).
- Uma ligação por vez: uma segunda ligação recebida durante uma conversa recebe sinal de ocupado.

## Solução de problemas

| Indicador / sintoma | Causa provável |
|---|---|
| "Telefone: requer HTTPS" | Acesso por `http://`. Configure o certificado (passos 1 e 3) e use `https://` |
| "Telefone: senha SIP não cadastrada" | Informe a senha SIP no cadastro do usuário (passo 4) |
| "Telefone: senha SIP incorreta" | Senha diferente do *secret* do ramal, **ou** o `chan_sip` capturando o WebSocket (passo 2.2). O log `/var/log/asterisk/full` mostra `chan_sip.c: Registration ... Wrong password` nesse segundo caso |
| "Telefone: desconectado" | WebSocket do Asterisk indisponível: confira o passo 2.1 e `journalctl -u switchboard` (`[sip] erro no WebSocket do Asterisk`) |
| Liga, mas sem áudio ou com áudio de um lado só | Portas UDP 10000–20000 bloqueadas no firewall do Issabel ou da VPS, ou NAT (passo 2.6) |
| Ligações para o ramal não tocam no navegador | Falta `transport=transport-ws` no ramal (passo 2.4) |
| "Permita o uso do microfone no navegador" | Microfone bloqueado: clique no cadeado da barra de endereço → Microfone → Permitir |
