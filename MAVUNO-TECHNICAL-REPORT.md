# Mavuno — relatório técnico para GitHub e Render

**Data da auditoria:** 2026-10-29  
**Escopo:** análise do projeto existente, preparação documental para GitHub/Render e criação de um pacote limpo. Não foi publicado nenhum serviço, não foi criado nenhum recurso pago e não foi alterada a visibilidade de nenhum repositório.

## 1. Conclusão executiva

O Mavuno é uma aplicação monolítica web em TypeScript que serve o frontend React/Vite, a API Express, o Socket.IO e os recursos PWA a partir do mesmo processo Node.js. Usa PostgreSQL externo através de Drizzle ORM e possui integração LiveKit no servidor/cliente para voz, ainda sem validação de áudio real entre dispositivos.

O projeto está tecnicamente preparado para ser colocado num repositório GitHub e ligado a um Render Web Service. O `Dockerfile`, o `package.json`, o `pnpm-lock.yaml`, o endpoint de health check e a utilização de `PORT`/`0.0.0.0` estão presentes. Render suporta WebSockets e TLS gerido para Web Services; a configuração deve ser feita no Dashboard ou por Blueprint, sem guardar segredos no repositório [1] [2].

A publicação ainda não foi feita. Antes de enviar o código, a credencial PostgreSQL atualmente usada no `.env` local deve ser revogada/rotacionada, porque foi partilhada no contexto desta tarefa. O relatório não reproduz o valor nem qualquer parte sensível da credencial. O GitHub recomenda revogar/rotacionar segredos expostos e nunca os hardcodar [5] [6].

## 2. Estrutura do projeto

```text
mavuno/
├── .dockerignore              # exclui dependências, build, .env e logs da imagem
├── .env.example               # nomes e valores demonstrativos; não contém credenciais reais
├── .gitignore                 # exclui node_modules, dist, .env, logs e coverage
├── Dockerfile                 # build multistage Node 22 Alpine para produção
├── FINAL-REPORT.md            # relatório anterior de testes e pendências
├── MAVUNO-TECHNICAL-REPORT.md # este relatório
├── README.md                  # instalação, operação, LiveKit, PWA e alojamento
├── TODO.md                    # matriz de funcionalidades concluídas/parciais/pendentes
├── plan.md                    # decisões de arquitetura e princípios de produto
├── package.json               # scripts, versões e dependências
├── pnpm-lock.yaml             # resolução reprodutível das dependências
├── pnpm-workspace.yaml        # configuração pnpm do workspace
├── app.config.ts              # metadados da aplicação
├── drizzle.config.ts          # configuração Drizzle e carregamento de .env
├── tsconfig.json              # TypeScript estrito
├── vite.config.ts             # Vite, JSX automático e build do cliente
├── drizzle/
│   ├── 0000_odd_epoch.sql     # migração PostgreSQL inicial
│   └── meta/                   # snapshots e journal do Drizzle Kit
├── public/
│   ├── icon.svg               # ícone vetorial
│   ├── icon-192.png           # ícone PWA 192 px
│   ├── icon-512.png           # ícone PWA 512 px
│   ├── manifest.webmanifest   # manifesto instalável
│   ├── service-worker.js      # cache limitado ao shell estático
│   └── manus-routes.json      # rotas públicas do projeto
├── src/client/
│   ├── App.tsx                # autenticação, comunidades, canais, mensagens, voz e UI
│   ├── api.ts                 # cliente HTTP e tipos partilhados
│   ├── index.html             # shell HTML sem preâmbulo inline de Fast Refresh
│   ├── main.tsx               # bootstrap React e registo PWA
│   └── styles.css             # tema escuro, responsividade e acessibilidade
├── src/server/
│   ├── index.ts               # Express, Helmet, CSP, Socket.IO e serving SPA
│   ├── api.ts                 # API de autenticação, comunidades, mensagens e LiveKit
│   ├── security.ts            # scrypt, tokens opacos, cookies e CSRF
│   ├── permissions.ts         # membership e autorização
│   ├── roles.ts               # tipos de cargos
│   └── db/
│       ├── index.ts           # pool PostgreSQL e Drizzle
│       └── schema.ts          # tabelas, enums, índices e relações
└── tests/
    ├── security.test.ts       # testes unitários sem banco
    └── integration-smoke.ts   # smoke test opt-in com duas contas e limpeza dirigida
```

O diretório local também pode conter `.env`, `node_modules/` e `dist/` para desenvolvimento. Esses itens não fazem parte do pacote de entrega.

## 3. Tecnologias e dependências

### Frontend

- React 19 e React DOM 19.
- TypeScript 5.7.
- Vite 6 com JSX automático (`jsx: automatic`) e sem Fast Refresh inline, decisão necessária para manter a CSP/Preview.
- CSS próprio responsivo, sem dependência de framework visual.
- PWA com manifesto, ícones e service worker.
- `livekit-client` carregado para a área de voz.
- `socket.io-client` para mensagens e eventos em tempo real.

### Backend

- Node.js 22, módulos ES e Express 4.
- Helmet 8 com CSP, `frame-ancestors` restrito a hosts de Preview autorizados, `x-powered-by` desativado e limites de payload.
- `express-rate-limit` para a API e endpoints de autenticação.
- Zod para validação de entradas.
- Socket.IO 4 autenticado por cookie de sessão, com autorização de membership antes de entrar em canais.
- `livekit-server-sdk` para tokens de voz curtos emitidos somente no backend.
- `dotenv` para carregar `.env` local; em Render, as variáveis são injetadas pelo ambiente do serviço.

### Dados e segurança

- PostgreSQL através de `pg` e Drizzle ORM/Drizzle Kit.
- Migração SQL versionada em `drizzle/`.
- Entidades principais: users, sessions, communities, members, roles, permissions, channels, messages, mentions, invitations, voice rooms e password reset tokens.
- Passwords com scrypt e salt; sessões guardam apenas digest de tokens opacos.
- Cookies HttpOnly, CSRF para mutações e rate limiting.
- Mensagens com paginação, replies, mentions e chave idempotente `clientMessageId`.

## 4. Estado atual e resultados reais

### Funcionalidades implementadas

Estão implementados registo, login, logout, sessão, perfil, comunidades públicas/privadas, convites, entrada/saída, cargos, permissões, canais, mensagens persistentes, replies, mentions, paginação, Socket.IO, reconexão/retry, PWA e integração de token LiveKit.

Não estão implementados como funcionalidades concluídas: recuperação de conta por email, upload de ficheiros, planos Free/Pro, billing, integração iMali Way, notificações push, fóruns/tópicos, palco de voz e áudio real comprovado entre dispositivos.

### Testes executados

Os resultados abaixo são os resultados efetivamente registados nesta sessão de desenvolvimento:

| Verificação | Resultado real |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passou com pnpm 11.25.0 e lockfile aceite |
| `pnpm typecheck` | Passou |
| `pnpm test` | Passou: 4/4 testes de segurança |
| `pnpm build` | Passou: Vite produziu o cliente e esbuild produziu o bundle do servidor |
| `pnpm db:migrate` | Passou com PostgreSQL configurado; migração aplicada |
| `GET /api/health` | Passou com `status=ok` e `database=connected` |
| `MAVUNO_RUN_INTEGRATION_TESTS=1 pnpm test:integration` | Passou: 50 verificações, duas sessões Socket.IO e limpeza de 2 contas temporárias |
| Endpoint LiveKit no smoke test | Testado como indisponível porque LiveKit não estava configurado; não houve simulação de áudio |
| Docker build | Não executado: Docker CLI não estava disponível no sandbox |
| Áudio LiveKit físico | Não executado; exige dispositivos/microfones e credenciais LiveKit |
| Publicação externa | Não executada |

O smoke test não deve ser executado contra uma base de dados partilhada de produção sem uma estratégia de limpeza e isolamento. O teste atual cria dados temporários e limpa as contas criadas, mas o ambiente recomendado para ele é uma base descartável ou de staging.

## 5. Auditoria para GitHub e segredos

### Estado dos ficheiros

- `.gitignore` existe e exclui `node_modules/`, `dist/`, `.env`, `.env.*`, `coverage/`, `.DS_Store` e logs.
- `.dockerignore` exclui `node_modules`, `.git`, `dist`, `.env`, `.env.*` e logs.
- `.env.example` contém somente placeholders e nomes de variáveis.
- O ZIP preparado exclui `.env`, `node_modules/` e `dist/`.
- O diretório de trabalho atual **não contém `.git`**. Portanto não existe histórico Git local para auditar, nem se pode confirmar a ausência de segredos em commits anteriores ou clones externos.
- Não foi encontrado código pessoal de utilizadores. Os endereços usados nos testes são domínios de exemplo/invalid.
- O scan do código entregue encontrou apenas nomes de variáveis, placeholders, documentação e exemplos; não encontrou uma credencial incorporada no código-fonte.

### Risco crítico identificado

Existe um `.env` local que contém a credencial PostgreSQL usada para os testes. Ele está excluído por `.gitignore`, `.dockerignore` e pelo processo de criação do ZIP, mas a credencial foi fornecida no contexto desta tarefa. Deve ser considerada potencialmente exposta e **rotacionada/revogada antes de qualquer utilização no GitHub ou Render**. O relatório não mostra o valor, não o copia para outro ficheiro e não o inclui no ZIP.

Depois da rotação:

1. Atualizar a variável apenas no Render Environment, num `.env` local privado ou num gestor de segredos.
2. Não colocar a URL em README, `render.yaml`, issue, commit, logs ou frontend.
3. Se algum clone ou repositório antigo já tiver recebido a credencial, revogar primeiro e seguir o procedimento de limpeza do histórico GitHub. Rotacionar é prioritário; reescrever histórico tem efeitos sobre clones, branches, tags e pull requests [6].
4. Antes do primeiro push, executar uma auditoria local sem imprimir valores e ativar Secret Scanning/Push Protection quando disponível no repositório GitHub [5].

## 6. Preparação para Render

### Serviço recomendado

Criar um **Web Service** ligado ao repositório GitHub. A aplicação já serve frontend, backend e Socket.IO a partir do mesmo processo, portanto não é necessário um serviço frontend separado.

Configuração recomendada:

- **Language:** Node.
- **Build Command:** `corepack enable && pnpm install --frozen-lockfile && pnpm build`
- **Start Command:** `pnpm start`
- **Health Check Path:** `/api/health`
- **Port:** não fixar uma porta diferente no painel; o código usa `PORT` e faz bind em `0.0.0.0`. Render recomenda a variável `PORT` e exige bind em `0.0.0.0` [1] [3].
- **Auto-deploy:** ativar somente depois de o repositório e o branch correto serem confirmados.
- **TLS:** Render fornece HTTPS/TLS gerido para o domínio `onrender.com` e domínios personalizados [3].

Alternativamente, usar o `Dockerfile` existente como runtime Docker. Nesse caso, confirmar que a imagem recebe `PORT` e as variáveis de runtime; não copiar `.env` para a imagem.

### Variáveis de produção

Configurar no separador **Environment** do Web Service, nunca no repositório:

```text
POSTGRES_URL=<URL privada do PostgreSQL de produção>
LIVEKIT_URL=<URL wss do LiveKit, se voz estiver ativada>
LIVEKIT_API_KEY=<chave LiveKit, se voz estiver ativada>
LIVEKIT_API_SECRET=<segredo LiveKit, se voz estiver ativada>
COOKIE_SECURE=true
COOKIE_SAME_SITE=none
NODE_ENV=production
PG_POOL_SIZE=8
```

Render documenta que variáveis podem ser adicionadas individualmente ou importadas de um `.env` pelo Dashboard, mas o ficheiro local não deve ser commitado [2]. Para o primeiro deploy, é mais seguro inserir as variáveis diretamente no painel e escolher **Save, rebuild, and deploy**.

### PostgreSQL

Há duas opções:

1. **Render Postgres:** criar a base na mesma região do Web Service e usar a Internal Database URL no `POSTGRES_URL` sempre que possível. A documentação do Render recomenda a URL interna para reduzir latência; a URL externa é para clientes fora da rede privada [4].
2. **PostgreSQL externo:** usar a URL TLS fornecida pelo operador. Confirmar compatibilidade de `sslmode` com o fornecedor e aplicar migrações de forma controlada.

Executar a migração de produção como etapa administrativa única, antes de abrir o serviço aos utilizadores:

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
```

Não colocar `pnpm db:migrate` no `start` do Web Service, porque múltiplas instâncias/redeploys poderiam tentar migrar concorrentemente.

### WebSockets e voz

Render suporta WebSocket connections [3]. O Mavuno já usa Socket.IO no mesmo servidor HTTP, por isso o cliente deve ligar-se à mesma origem HTTPS e o Socket.IO negociará `wss` através do endpoint público.

O chat de voz exige um serviço LiveKit Cloud ou self-hosted com `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`. As chaves ficam apenas no backend. LiveKit é um serviço adicional e pode ter custos, limites de uso e requisitos próprios de plano; a voz não deve ser declarada operacional antes de testar microfone, entrada/saída, participantes e áudio bidirecional em dois dispositivos.

## 7. Configuração de produção ainda necessária

- Rotacionar a credencial PostgreSQL atualmente utilizada localmente.
- Criar o repositório GitHub e decidir a visibilidade; nenhuma decisão foi tomada nesta tarefa.
- Fazer o primeiro push apenas do conteúdo limpo.
- Criar PostgreSQL de produção/staging e escolher região.
- Aplicar a migração numa base isolada.
- Configurar as variáveis no Render.
- Definir `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=none` e `NODE_ENV=production`.
- Confirmar o health check `/api/health`.
- Configurar LiveKit apenas se a voz for necessária.
- Testar Socket.IO através do endereço HTTPS público.
- Testar registo/login, duas contas, convite, mensagem persistente, reload/reconnect e permissões no ambiente público.
- Configurar domínio personalizado se necessário; o endereço `onrender.com` já fornece HTTPS.
- Definir backups, retenção, monitorização e alertas para a base de dados de produção.

## 8. Custos e limitações

Os valores e limites dependem da oferta atual do Render e podem mudar. A documentação consultada indica que o plano Hobby é apresentado como `$0/mês + compute`, com limites de uso; o compute Free aparece como `$0/mês`, com 512 MB de RAM para serviços, enquanto o PostgreSQL Free aparece com 256 MB de RAM e 1 GB de armazenamento na página de preços consultada [7]. Confirmar os preços finais no Dashboard antes de criar qualquer recurso.

As limitações relevantes do Render Free incluem:

- Web Service Free pode entrar em sleep após 15 minutos sem tráfego e pode levar cerca de um minuto a voltar.
- O filesystem é efémero; não guardar uploads ou dados locais como fonte de verdade.
- O Free Postgres indicado na documentação expira 30 dias depois da criação, tem limite de 1 GB e não oferece backups nem connection pooling gerido.
- Há limites de horas, bandwidth e minutos de build; exceder limites pode suspender serviços ou gerar cobrança conforme a configuração da conta.
- Free Web Services não suportam escala horizontal além de uma instância e podem reiniciar.
- LiveKit Cloud/self-hosted, domínio, email, backups e observabilidade podem introduzir custos próprios.
- O GitHub pode ser gratuito para o repositório, mas funcionalidades de segurança, equipa, runners ou armazenamento podem depender do plano e uso.

Para uma aplicação pública com dados de utilizadores, o Free Postgres de 30 dias e sem backups não deve ser tratado como base de produção. A decisão mínima prudente é usar staging Free apenas para validação e escolher um plano com persistência/backups apropriados para produção.

## 9. Plano exato de publicação

### Fase A — segurança e preparação local

1. Revogar/rotacionar a credencial PostgreSQL usada nos testes.
2. Confirmar que o novo segredo existe apenas no `.env` local ou no gestor de segredos.
3. Remover `node_modules/`, `dist/` e `.env` do diretório que será inicializado como Git, ou manter os ignores e confirmar com `git status`.
4. Extrair o ZIP limpo para uma pasta nova.
5. Executar:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

6. Usar uma base de staging para executar `pnpm db:migrate` e `MAVUNO_RUN_INTEGRATION_TESTS=1 pnpm test:integration`.
7. Inspecionar `git diff --check`, confirmar `.env` ignorado e procurar segredos sem imprimir valores.

### Fase B — GitHub

1. Em GitHub, clicar em **New repository**.
2. Escolher nome, proprietário e visibilidade conscientemente; não fazer essa escolha automaticamente.
3. Criar o repositório vazio, sem README/`.gitignore` adicional se já for usar os ficheiros do projeto.
4. Na pasta limpa:

```bash
git init -b main
git add .
git status --short
```

5. Confirmar que `.env`, `node_modules/`, `dist/` e qualquer ficheiro de teste com dados reais não aparecem no staging.
6. Fazer o primeiro commit somente depois da revisão:

```bash
git commit -m "Prepare Mavuno for deployment"
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

7. Ativar Secret Scanning/Push Protection quando disponível e rever o conteúdo do branch no site GitHub.

### Fase C — Render

1. Abrir o Render Dashboard e escolher **New → Web Service**.
2. Ligar a conta GitHub e selecionar o repositório/branch `main`.
3. Escolher região próxima do PostgreSQL e dos utilizadores.
4. Definir os comandos de build/start indicados neste relatório.
5. Definir `/api/health` como health check.
6. Adicionar as variáveis de ambiente no painel, sem colocar valores no repositório.
7. Criar ou selecionar o PostgreSQL e usar a Internal Database URL quando Web Service e banco estiverem na mesma região.
8. Escolher o plano conscientemente, considerando sleep, expiração, backups, limites e custos.
9. Fazer o primeiro deploy manual.
10. Confirmar os logs sem segredos e abrir o endereço `https://<servico>.onrender.com`.
11. Testar `/api/health`, registo, login, comunidades, mensagens e Socket.IO.
12. Só depois configurar domínio personalizado, LiveKit e auto-deploy.

Não executar qualquer passo de criação de repositório, deploy, compra ou alteração de visibilidade sem autorização explícita.

## 10. Entrega preparada

Foi preparado um ZIP atualizado com o código-fonte, migrações, testes, configuração LiveKit, Dockerfile, README e este relatório. O pacote exclui:

- `.env` e credenciais;
- `node_modules/`;
- `dist/`;
- logs e ficheiros temporários;
- dados pessoais de utilizadores.

O ZIP foi validado com teste de integridade e extração numa pasta limpa.

## 11. Estado final

### Pronto

- Código frontend/backend e PWA organizados.
- PostgreSQL/Drizzle e migração versionada.
- Testes unitários e smoke test de integração existentes.
- Build TypeScript/Vite/esbuild funcional.
- Socket.IO e health check implementados.
- Dockerfile multistage preparado.
- `.gitignore`, `.dockerignore` e `.env.example` presentes.
- Relatório técnico e instruções GitHub/Render preparados.
- ZIP limpo criado e validado.

### Falta fazer

- Rotacionar a credencial PostgreSQL partilhada.
- Criar e configurar o repositório GitHub.
- Criar/configurar os serviços Render.
- Aplicar migrações numa base de produção/staging escolhida.
- Configurar LiveKit se a voz for necessária.
- Executar os testes no endereço público HTTPS.
- Definir plano de backups, monitorização e custos.

### Riscos principais

1. A credencial PostgreSQL atual deve ser tratada como exposta e rotacionada.
2. O projeto não tem histórico Git local; não é possível afirmar que clones/históricos externos estão limpos.
3. Free Render não é adequado como garantia de produção devido a sleep, expiração de Postgres, ausência de backups e limites.
4. A voz LiveKit continua não verificada com áudio real.
5. O build Docker não foi executado neste sandbox por falta do Docker CLI.
6. O smoke test cria dados na base indicada; usar uma base de staging/descartável antes de automatizar.
7. Não existem planos Free/Pro ou pagamentos implementados; não apresentar cobrança como ativa.

## Referências oficiais

[1]: https://render.com/docs/deploy-node-express-app "Deploy a Node Express App on Render"
[2]: https://render.com/docs/configure-environment-variables "Render Environment Variables and Secrets"
[3]: https://render.com/docs/web-services "Render Web Services"
[4]: https://render.com/docs/postgresql-creating-connecting "Create and Connect to Render Postgres"
[5]: https://docs.github.com/en/get-started/learning-to-code/storing-your-secrets-safely "GitHub — Storing your secrets safely"
[6]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository "GitHub — Removing sensitive data from a repository"
[7]: https://render.com/pricing "Render Pricing"
