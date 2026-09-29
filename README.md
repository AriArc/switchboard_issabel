# Switchboard Intek — Issabel

Mesa operadora (switchboard) web para PABX **Issabel/Asterisk**, com a identidade visual da
**Intek Telecomunicações** e **click-to-call**.

- Painel em tempo real dos ramais (livre, em ligação, tocando, em espera, indisponível) e das chamadas ativas
- **Click-to-call**: pelo discador, pelo botão de cada ramal ou por link (`/?call=11999990000`)
- **Ramal discador fixo por usuário**: o click-to-call sempre usa o ramal associado ao usuário no cadastro;
  o navegador não consegue escolher outro ramal de origem
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

## Requisitos

- Node.js 18 ou superior
- Acesso ao AMI do Issabel (porta 5038)

## Configuração do AMI no Issabel

Crie um usuário AMI em `/etc/asterisk/manager_custom.conf`:

```ini
[switchboard]
secret = uma-senha-forte
deny = 0.0.0.0/0.0.0.0
permit = 192.168.0.50/255.255.255.255   ; IP do servidor do switchboard
read = system,call,agent,user,config,command,reporting,originate
write = system,call,agent,user,config,command,reporting,originate
writetimeout = 5000
```

Depois recarregue: `asterisk -rx "manager reload"`.

## Instalação

```bash
npm install
cp .env.example .env   # ajuste AMI_HOST, AMI_USER, AMI_SECRET, SESSION_SECRET etc.
npm start
```

Acesse `http://<servidor>:8080`. No primeiro start é criado o administrador definido em
`ADMIN_USER` / `ADMIN_PASSWORD` (padrão `admin` / `admin123`). **Troque a senha logo após o primeiro acesso.**

Em **Usuários → Novo usuário**, informe nome, login, senha, perfil e o **ramal discador**.
O campo sugere os ramais lidos do Issabel. Cada ramal só pode ser associado a um usuário.

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `8080` | Porta HTTP |
| `SESSION_SECRET` | — | Segredo para assinar as sessões (obrigatório em produção) |
| `AMI_HOST` / `AMI_PORT` | `127.0.0.1` / `5038` | Endereço do AMI |
| `AMI_USER` / `AMI_SECRET` | — | Credenciais do AMI |
| `CHANNEL_TECH` | `SIP` | `SIP` (chan_sip) ou `PJSIP` |
| `DIAL_CONTEXT` | `from-internal` | Contexto usado para discar o destino |
| `HINT_CONTEXT` | `ext-local` | Contexto dos hints dos ramais |
| `ORIGINATE_TIMEOUT_MS` | `30000` | Tempo que o ramal do usuário fica tocando |
| `SESSION_TTL_HOURS` | `12` | Duração da sessão |
| `DATA_FILE` | `data/users.json` | Arquivo do cadastro de usuários |
| `MOCK_PBX` | `0` | `1` simula um PABX (demonstração sem Issabel) |

### Demonstração sem Issabel

```bash
npm run dev   # MOCK_PBX=1, PABX simulado com ramais e chamadas aleatórias
```

### Integração com CRM

Abra `http://<servidor>:8080/?call=<número>` a partir do CRM. Após confirmar, o
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
  app.js        rotas da API (login, click-to-call, chamadas, usuários)
  ami.js        cliente AMI (Asterisk Manager Interface)
  pbx.js        estado de ramais/chamadas a partir dos eventos do AMI
  mock-pbx.js   PABX simulado
  users.js      cadastro de usuários (JSON) com hash scrypt
  auth.js       sessão por cookie assinado (HMAC)
public/         interface web (HTML/CSS/JS, sem build)
test/           testes (node:test)
```

Em produção, publique atrás de um proxy HTTPS (nginx) e mantenha o AMI acessível apenas pelo servidor do switchboard.
