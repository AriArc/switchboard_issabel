# Switchboard Intek — Issabel

Mesa operadora (switchboard) web para PABX **Issabel/Asterisk**, com a identidade visual da
**Intek Telecomunicações** e **click-to-call**.

- Painel em tempo real dos ramais (livre, em ligação, tocando, em espera, indisponível) e das chamadas ativas
- **Click-to-call**: pelo discador, pelo botão de cada ramal ou por link (`/?call=11999990000`)
- **Ramal discador fixo por usuário**: o click-to-call sempre usa o ramal associado ao usuário no cadastro;
  o navegador não consegue escolher outro ramal de origem
- **Histórico de ligações** do próprio ramal (aba *Histórico*): recebidas, realizadas e perdidas, com período,
  busca, totais e botão para ligar de volta. Cada usuário só vê as ligações do ramal cadastrado para ele
- Usuários do perfil **Usuário** entram sempre direto no painel do switchboard
- Transferência e desligamento de chamadas (operadores/administradores em qualquer chamada, usuários só nas próprias)
- Cadastro de usuários com perfis: **Administrador**, **Operador (mesa)** e **Usuário**
- Tema claro/escuro e layout responsivo

## Como o click-to-call funciona

1. O usuário informa o destino e clica em **Ligar**.
2. O servidor busca o ramal discador do usuário no cadastro e envia um `Originate` ao AMI:
   `Channel: SIP/<ramal>` (ou `PJSIP/<ramal>`), `Context: from-internal`, `Exten: <destino>`.
3. O telefone do usuário toca exibindo "Chamando &lt;destino&gt;". Ao atender, o Issabel disca o destino
   usando as rotas de saída normais. O número do CallerID é o ramal do usuário, então permissões,
   rotas e CDR funcionam como numa ligação feita pelo próprio aparelho.

## Cenário de instalação

Este guia considera o **Issabel 5 (Rocky Linux 8)** e o **switchboard na mesma VPS**:

```
 Usuários (navegador) ──HTTPS──▶ IP público da VPS :8443
                                   │  Apache do Issabel (proxy)
                                   ▼
                          switchboard 127.0.0.1:8080
                             │                 │
                    AMI 127.0.0.1:5038   MariaDB 127.0.0.1:3306
                             └──── Issabel ────┘
```

- Os usuários só acessam o **IP público** (ou domínio) da VPS para entrar no sistema.
- O switchboard conversa com o Asterisk (AMI) e com o banco de CDR **pela própria máquina** (`127.0.0.1`).
  As portas **5038 e 3306 não precisam e não devem** ficar abertas para a internet.
- As portas 80/443 já são usadas pela interface do Issabel; o switchboard é publicado na **8443**.

Todos os comandos abaixo são executados como `root` na VPS.

## 1. Instalar o Node.js e o switchboard

```bash
dnf module reset -y nodejs
dnf module enable -y nodejs:20
dnf install -y nodejs git

useradd --system --home-dir /opt/switchboard_issabel --shell /sbin/nologin switchboard
git clone https://github.com/AriArc/switchboard_issabel.git /opt/switchboard_issabel
cd /opt/switchboard_issabel
npm install --omit=dev
cp .env.example .env
chown -R switchboard:switchboard /opt/switchboard_issabel
chmod 600 .env
```

## 2. Usuário do AMI (Asterisk)

Adicione ao final de `/etc/asterisk/manager_custom.conf`:

```ini
[switchboard]
secret = uma-senha-forte-ami
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255   ; só aceita conexão da própria VPS
read = system,call,agent,user,config,command,reporting,originate
write = system,call,agent,user,config,command,reporting,originate
writetimeout = 5000
```

Recarregue e confira:

```bash
asterisk -rx "manager reload"
asterisk -rx "manager show user switchboard"
```

## 3. Usuário do banco de CDR (aba Histórico)

O histórico é lido da tabela `cdr` do banco `asteriskcdrdb`. Crie um usuário **somente leitura**,
que só conecta a partir da própria VPS:

```bash
mysql -u root -p
```

```sql
CREATE USER 'switchboard'@'127.0.0.1' IDENTIFIED BY 'uma-senha-forte-cdr';
GRANT SELECT ON asteriskcdrdb.cdr TO 'switchboard'@'127.0.0.1';
FLUSH PRIVILEGES;
```

A senha do `root` do MariaDB é a definida na instalação do Issabel.
Sem `CDR_DB_HOST` configurado, o restante do sistema funciona normalmente e a aba Histórico mostra um aviso.

## 4. Configurar o `.env`

Edite `/opt/switchboard_issabel/.env`:

```ini
PORT=8080
HOST=127.0.0.1
SESSION_SECRET=<saída de: openssl rand -hex 32>

AMI_HOST=127.0.0.1
AMI_USER=switchboard
AMI_SECRET=uma-senha-forte-ami

CHANNEL_TECH=SIP        # ou PJSIP (veja abaixo)

CDR_DB_HOST=127.0.0.1
CDR_DB_USER=switchboard
CDR_DB_PASSWORD=uma-senha-forte-cdr

ADMIN_USER=admin
ADMIN_PASSWORD=<senha inicial do administrador>
```

**SIP ou PJSIP?** No Issabel, em *PBX → Extensões*, veja o tipo de dispositivo dos ramais, ou rode:

```bash
asterisk -rx "sip show peers"        # lista ramais chan_sip  -> CHANNEL_TECH=SIP
asterisk -rx "pjsip show endpoints"  # lista ramais PJSIP     -> CHANNEL_TECH=PJSIP
```

## 5. Rodar como serviço

```bash
cp /opt/switchboard_issabel/deploy/switchboard.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now switchboard
systemctl status switchboard          # deve mostrar "active (running)"
journalctl -u switchboard -f          # logs; deve aparecer "[ami] conectado em 127.0.0.1:5038"
```

## 6. Publicar com HTTPS pelo Apache do Issabel

O Apache do Issabel faz o HTTPS e repassa as requisições para o switchboard local:

```bash
cp /opt/switchboard_issabel/deploy/apache-switchboard.conf /etc/httpd/conf.d/switchboard.conf
apachectl configtest                  # deve responder "Syntax OK"
systemctl reload httpd
```

O arquivo usa o mesmo certificado da interface do Issabel. Se você usa outro certificado
(ex.: Let's Encrypt para um domínio), ajuste `SSLCertificateFile`/`SSLCertificateKeyFile`.
Com o certificado autoassinado padrão, o navegador mostra um aviso na primeira vez.

## 7. Liberar a porta 8443 no firewall

Libere **apenas a porta 8443/TCP**. As portas 5038, 3306 e 8080 continuam fechadas para a internet.

- **Firewall do Issabel** (*Segurança → Firewall*): crie uma regra de entrada permitindo TCP na porta 8443.
- Se o `firewalld` estiver ativo (`systemctl is-active firewalld`):
  ```bash
  firewall-cmd --permanent --add-port=8443/tcp && firewall-cmd --reload
  ```
- Se o provedor da VPS tiver firewall no painel (security group), libere a 8443 lá também.

## 8. Primeiro acesso

Acesse `https://<IP-publico-da-VPS>:8443` e entre com `ADMIN_USER` / `ADMIN_PASSWORD`.
**Troque a senha do administrador logo após o primeiro acesso.**

Em **Usuários → Novo usuário**, informe nome, login, senha, perfil e o **ramal discador**.
O campo sugere os ramais lidos do Issabel. Cada ramal só pode ser associado a um usuário.

## Atualizar para uma nova versão

```bash
cd /opt/switchboard_issabel
sudo -u switchboard git pull
sudo -u switchboard npm install --omit=dev
systemctl restart switchboard
```

O cadastro de usuários fica em `data/users.json` e não é afetado pela atualização (inclua esse arquivo no seu backup).

## Solução de problemas

| Sintoma | Verifique |
|---|---|
| Topo do painel mostra "PABX desconectado" | `journalctl -u switchboard`; usuário/senha do AMI; `permit = 127.0.0.1` e `manager reload` |
| Painel sem ramais ou sem nomes | Permissões `command` e `reporting` no usuário AMI; `HINT_CONTEXT=ext-local` |
| Click-to-call não toca o ramal | `CHANNEL_TECH` (SIP × PJSIP); ramal registrado (`sip show peers` / `pjsip show contacts`) |
| Aba Histórico: "Não foi possível consultar" | Usuário `'switchboard'@'127.0.0.1'` e senha do CDR. Se o MariaDB não escuta em TCP, use `CDR_DB_SOCKET=/var/lib/mysql/mysql.sock` e crie o usuário como `'switchboard'@'localhost'` |
| Painel não atualiza em tempo real | Módulo `proxy_wstunnel` do Apache (`httpd -M \| grep wstunnel`) |
| `https://IP:8443` não abre | Regra da 8443 no firewall do Issabel / firewalld / painel da VPS; `systemctl status httpd` |
| Erro 503 no navegador | `systemctl status switchboard` (serviço parado) |

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `8080` | Porta HTTP do switchboard |
| `HOST` | `0.0.0.0` | Endereço de escuta (`127.0.0.1` atrás do Apache) |
| `SESSION_SECRET` | — | Segredo para assinar as sessões (obrigatório em produção) |
| `AMI_HOST` / `AMI_PORT` | `127.0.0.1` / `5038` | Endereço do AMI |
| `AMI_USER` / `AMI_SECRET` | — | Credenciais do AMI |
| `CHANNEL_TECH` | `SIP` | `SIP` (chan_sip) ou `PJSIP` |
| `DIAL_CONTEXT` | `from-internal` | Contexto usado para discar o destino |
| `HINT_CONTEXT` | `ext-local` | Contexto dos hints dos ramais |
| `ORIGINATE_TIMEOUT_MS` | `30000` | Tempo que o ramal do usuário fica tocando |
| `CDR_DB_HOST` / `CDR_DB_PORT` | — / `3306` | MariaDB do Issabel com o CDR (aba Histórico) |
| `CDR_DB_SOCKET` | — | Socket local do MariaDB (alternativa ao TCP) |
| `CDR_DB_USER` / `CDR_DB_PASSWORD` | — | Usuário somente leitura do CDR |
| `CDR_DB_NAME` / `CDR_DB_TABLE` | `asteriskcdrdb` / `cdr` | Banco e tabela do CDR |
| `SESSION_TTL_HOURS` | `12` | Duração da sessão |
| `DATA_FILE` | `data/users.json` | Arquivo do cadastro de usuários |
| `MOCK_PBX` | `0` | `1` simula um PABX (demonstração sem Issabel) |

### Demonstração sem Issabel

```bash
npm run dev   # MOCK_PBX=1, PABX simulado com ramais e chamadas aleatórias
```

### Integração com CRM

Abra `https://<IP-publico-da-VPS>:8443/?call=<número>` a partir do CRM. Após confirmar, o
switchboard liga pelo ramal do usuário logado.

## Testes

```bash
npm test
```

Os testes usam um servidor AMI falso e verificam, entre outras coisas, que o `Originate` sai
sempre do ramal cadastrado do usuário, mesmo que a requisição tente informar outro ramal.

## Estrutura

```
server/
  index.js      servidor HTTP + WebSocket
  app.js        rotas da API (login, click-to-call, chamadas, histórico, usuários)
  cdr.js        histórico de ligações (MySQL do Issabel ou simulado)
  ami.js        cliente AMI (Asterisk Manager Interface)
  pbx.js        estado de ramais/chamadas a partir dos eventos do AMI
  mock-pbx.js   PABX simulado
  users.js      cadastro de usuários (JSON) com hash scrypt
  auth.js       sessão por cookie assinado (HMAC)
public/         interface web (HTML/CSS/JS, sem build)
deploy/         serviço systemd e configuração do Apache
test/           testes (node:test)
```

