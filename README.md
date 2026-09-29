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
   `Channel: PJSIP/<ramal>`, `Context: from-internal`, `Exten: <destino>`.
3. O telefone do usuário toca exibindo "Chamando &lt;destino&gt;". Ao atender, o Issabel disca o destino
   usando as rotas de saída normais. O número do CallerID é o ramal do usuário, então permissões,
   rotas e CDR funcionam como numa ligação feita pelo próprio aparelho.

## Cenário de instalação

Este guia considera o **Issabel 5 (Rocky Linux 8)** e o **switchboard na mesma VPS**:

```
 Usuários (navegador) ──HTTPS──▶ https://<IP-publico>:8443
                                   │  Apache do Issabel (proxy)
                                   ▼
                          switchboard 127.0.0.1:8080
                             │                 │
                    AMI 127.0.0.1:5038   MariaDB 127.0.0.1:3306
                             └──── Issabel ────┘
```

- Os usuários acessam direto o **IP público** da VPS (sem domínio) para entrar no sistema.
- Todos os ramais são **PJSIP**.
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

CHANNEL_TECH=PJSIP

CDR_DB_HOST=127.0.0.1
CDR_DB_USER=switchboard
CDR_DB_PASSWORD=uma-senha-forte-cdr

ADMIN_USER=admin
ADMIN_PASSWORD=<senha inicial do administrador>
```

Confira se os ramais PJSIP aparecem registrados (necessário para o click-to-call tocar o aparelho):

```bash
asterisk -rx "pjsip show contacts"
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

Como o acesso é pelo IP público (sem domínio), o HTTPS usa um **certificado autoassinado** gerado
para esse IP. Troque `203.0.113.10` pelo IP público da sua VPS:

```bash
IP=203.0.113.10
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=$IP/O=Intek Telecomunicacoes" \
  -addext "subjectAltName=IP:$IP" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign" \
  -addext "extendedKeyUsage=serverAuth" \
  -keyout /etc/pki/tls/private/switchboard.key \
  -out /etc/pki/tls/certs/switchboard.crt
chmod 600 /etc/pki/tls/private/switchboard.key
```

Depois ative o proxy:

```bash
cp /opt/switchboard_issabel/deploy/apache-switchboard.conf /etc/httpd/conf.d/switchboard.conf
apachectl configtest                  # deve responder "Syntax OK"
systemctl reload httpd
```

### Aviso de "conexão não segura" no navegador

O tráfego fica criptografado, mas como o certificado não é emitido por uma autoridade pública, o
navegador mostra um aviso. Há duas opções:

- **Aceitar o aviso** em cada computador: *Avançado → Continuar para o site*. É preciso fazer uma vez por navegador.
- **Instalar o certificado como confiável** nos computadores dos usuários para o aviso sumir de vez.
  Copie `/etc/pki/tls/certs/switchboard.crt` da VPS (ex.: via WinSCP) e:
  - **Windows** (Chrome/Edge): dê dois cliques no arquivo → *Instalar Certificado* → *Máquina Local* →
    *Colocar todos os certificados no repositório a seguir* → **Autoridades de Certificação Raiz Confiáveis** → Concluir.
    Reinicie o navegador.
  - **Firefox**: *Configurações → Privacidade e Segurança → Certificados → Ver certificados →
    Autoridades → Importar* → marque "Confiar nesta CA para identificar sites".

  Em empresas com Active Directory, o certificado pode ser distribuído para todas as máquinas por GPO.

> Se o IP público da VPS mudar, gere o certificado de novo com o IP novo e reinstale nos computadores.
> Se no futuro houver um domínio apontando para a VPS, dá para usar um certificado gratuito do Let's Encrypt
> e o aviso deixa de existir sem instalar nada nos computadores.

## 7. Liberar a porta 8443 no firewall

Libere **apenas a porta 8443/TCP**. As portas 5038, 3306 e 8080 continuam fechadas para a internet.

- **Firewall do Issabel** (pela interface web):
  1. *Segurança → Firewall → Definir Portas*: crie a porta **Switchboard**, protocolo **TCP**, porta **8443**.
  2. *Segurança → Firewall → Regras do Firewall → Nova regra*:

     | Campo | Valor |
     |---|---|
     | Tráfego | ENTRADA |
     | Entrada | QUALQUER |
     | Endereço de Origem | `0.0.0.0` / **`0`** (qualquer IP) |
     | Endereço de Destino | `0.0.0.0` / **`0`** |
     | Protocolo | TCP |
     | Porta de Origem | **QUALQUER** |
     | Porta de Destino | Switchboard |
     | Target | ACEITO |

     Atenção: máscara `/24` em `0.0.0.0` **não** significa "qualquer IP", e a porta de origem deve ser
     QUALQUER (o navegador usa uma porta aleatória); com outros valores a regra nunca é aplicada.
  3. Confirme que a regra está **acima** de qualquer regra de bloqueio geral (use as setas para reordenar)
     e que o firewall está ativo.
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
| Click-to-call não toca o ramal | `CHANNEL_TECH=PJSIP`; ramal registrado (`asterisk -rx "pjsip show contacts"`) |
| Aba Histórico: "Não foi possível consultar" | Usuário `'switchboard'@'127.0.0.1'` e senha do CDR. Se o MariaDB não escuta em TCP, use `CDR_DB_SOCKET=/var/lib/mysql/mysql.sock` e crie o usuário como `'switchboard'@'localhost'` |
| Painel não atualiza em tempo real | Módulo `proxy_wstunnel` do Apache (`httpd -M \| grep wstunnel`) |
| Navegador avisa "conexão não segura" | Esperado com certificado autoassinado; veja o passo 6 para instalar o certificado nos computadores |
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
| `CHANNEL_TECH` | `PJSIP` | `PJSIP` ou `SIP` (chan_sip) |
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

