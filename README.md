# Mavuno — Comunidades e conversas

Primeira versão funcional de uma plataforma web de comunidades e mensagens, com identidade própria, interface escura e navegação responsiva. O projeto usa React/Vite e TypeScript, Node.js/Express, PostgreSQL, Socket.IO e uma PWA leve. Foi pensado para ecrãs pequenos e ligações modestas; não reproduz a marca do Discord.

## Estado e limitações conhecidas

- **Concluído e validado:** registo, login, logout, sessão segura, perfis, comunidades públicas/privadas, convite, saída, cargos e moderação básicos, descoberta, mensagens persistentes em tempo real, paginação, menções/respostas, PWA assets e painel móvel.
- **Parcial — voz:** salas e interface LiveKit estão ligadas a tokens curtos emitidos e autorizados no servidor. O endpoint de token passou a integração. Áudio bidirecional entre contas/dispositivos, microfone real e saída de áudio ainda não foram comprovados; não declarar voz operacional antes desse teste.
- **Pendente — recuperação de conta:** não há fornecedor de email configurado. O endpoint devolve uma resposta explícita de serviço indisponível em vez de simular o envio.
- **Não incluído nesta versão:** upload de ficheiros; os avatares aceitam URL externa. O service worker guarda apenas recursos estáticos e não guarda sessões, mensagens, respostas privadas nem dados API. Não se promete utilização offline completa.
- **Publicação:** o Dockerfile e as instruções abaixo preparam um alojamento compatível; este repositório ainda não foi publicado para utilizadores finais.

## Requisitos

- Node.js 22 ou superior e pnpm 11 (a versão é fixada em `package.json`).
- Uma instância **PostgreSQL** acessível por TLS com certificado validado. Usar `sslmode=verify-full` na URL de produção (como no `.env.example`); o driver respeita esse modo sem desligar a validação TLS. O PostgreSQL é uma escolha deliberada: a base de dados gerida da plataforma é MySQL e não é usada pela aplicação.
- LiveKit Cloud ou self-hosted apenas se for testar áudio real.
- Docker opcional para execução em alojamento por container.

## Instalação local

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Preencher `.env` com a ligação PostgreSQL e, se necessário, as credenciais LiveKit. Não versionar `.env`. Para executar em **HTTP local simples**, usar `COOKIE_SECURE=false` e `COOKIE_SAME_SITE=lax`; isso é apenas para localhost. Para Preview HTTPS incorporado ou produção HTTPS, usar `COOKIE_SECURE=true` e `COOKIE_SAME_SITE=none` como no exemplo. Os atributos não são inferidos de `NODE_ENV` nem da ligação interna do servidor.

### Configuração local segura do PostgreSQL

Se `POSTGRES_URL` não aparecer no processo do terminal, criar ou editar o ficheiro local `.env` na raiz do projeto e preencher somente a linha abaixo com o valor fornecido pelo operador da base de dados:

```dotenv
POSTGRES_URL=
```

O ficheiro `.env` é ignorado pelo Git e pelo Docker e nunca deve ser incluído no ZIP. `src/server/index.ts`, os testes e `drizzle.config.ts` carregam esse ficheiro através de `dotenv`. Depois de guardar, abrir um novo terminal na raiz do projeto e confirmar apenas a presença, sem imprimir o segredo:

```bash
test -n "$POSTGRES_URL" || true # a aplicação/testes também carregam `.env`
pnpm db:migrate
MAVUNO_RUN_INTEGRATION_TESTS=1 pnpm test:integration
```

Não colar o valor em chats, logs, comandos com `echo`, URLs públicas ou ficheiros versionados. Para uma sessão que injete variáveis diretamente, configurar `POSTGRES_URL` no painel de secrets do serviço que executa o processo e reiniciar essa sessão antes de correr os comandos.

Executar uma vez as migrações e iniciar o servidor:

```bash
pnpm db:migrate
pnpm dev
```

O servidor de desenvolvimento usa a porta 3000. `GET /api/health` confirma o estado HTTP e PostgreSQL. A aplicação, API e Socket.IO partilham a mesma origem. Depois de alterar `src/server/db/schema.ts`, gerar e rever a nova migração antes de aplicá-la:

```bash
pnpm db:generate
pnpm db:migrate
```

## Configuração da voz LiveKit

Definir, apenas no ambiente do servidor:

```dotenv
LIVEKIT_URL=wss://SEU-PROJETO.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

O servidor verifica a associação/permissão e emite tokens LiveKit; a chave secreta nunca é enviada ao cliente. Sem os três valores válidos, a entrada numa sala falha explicitamente. A integração de token foi testada, mas ainda falta validar áudio real simultâneo com utilizadores em contas/dispositivos distintos, autorização de microfone e saída da sala. Não confundir a emissão de token com uma chamada funcional.

A recuperação de conta precisa de um fornecedor de email/transporte de mensagens — ainda não configurado — e por isso está desativada.

## Planos Free/Pro e pagamentos

O estado entregue nesta versão não contém um modelo de subscrição Free/Pro, regras de limites pagas, cobrança, renovação ou ativação de funcionalidades Pro. Não há qualquer endpoint ou ecrã que apresente uma subscrição como ativa; estes pontos permanecem pendentes e devem ser implementados no backend antes de serem expostos na interface.

A integração futura com a iMali Way está somente preparada como decisão de arquitetura, não como integração executável. A documentação pública da iMaliPay descreve uma API única, ferramentas de teste e acesso mediante demonstração, mas não disponibiliza nesta página endpoints, formatos de webhook ou credenciais que permitam uma implementação verificável ([documentação oficial](https://www.imalipay.com/developers)). Por isso o projeto não inventa URLs, payloads, chaves ou resultados de pagamento. Quando a iMali Way fornecer acesso autorizado, a implementação deverá manter as credenciais no servidor, usar Sandbox, guardar transações com um identificador idempotente, validar notificações assinadas e só ativar/renovar Pro após confirmação server-to-server. M-Pesa e cartões Visa/Mastercard continuam pendentes de documentação, aprovação e credenciais do comerciante.

## PWA e redes lentas

`public/manifest.webmanifest`, os ícones SVG/PNG (192 e 512 px) e `public/service-worker.js` fornecem a base instalável. O cache é versionado, instala manifesto/ícones e, sob demanda, guarda apenas recursos estáticos same-origin JS/CSS/fonts/ícones/manifesto. Caminhos `/api/` e `/socket.io/` são excluídos; conversas privadas e dados da sessão não são cacheados. A voz LiveKit é carregada sob demanda. A interface mostra ligação, envio pendente e falha; o utilizador pode tentar novamente com o mesmo identificador idempotente para evitar duplicação. Após reconectar, o cliente busca a página recente e mescla por ID sem duplicar mensagens; isso foi verificado no Chromium com uma mensagem criada enquanto o browser estava offline. O teste PWA de produção confirmou service worker ativo/controlador, manifest standalone, PNG nos dois tamanhos, JS/CSS hashed guardados e JavaScript disponível offline, enquanto `/api/health` falha sem rede e nunca entra no cache.

O cache do shell não transforma a aplicação numa plataforma offline: autenticação, mensagens, comunidades e áudio continuam a exigir rede e servidor.

## Testes e verificações

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` não toca na base de dados e cobre hashing scrypt, verificação de palavra-passe e tokens de sessão. Para o smoke test end-to-end com o servidor e uma base de dados **descartável/de teste**, executar separadamente:

```bash
MAVUNO_RUN_INTEGRATION_TESTS=1 pnpm test:integration
```

O teste exige o servidor em execução, cria contas/comunidades/mensagens temporárias e limpa, no `finally`, somente os registos identificados que criou. Não executar contra uma base de dados partilhada de produção ou com dados de terceiros. A suite padrão não faz estas escritas.

**Resultados desta execução:** `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` (4/4) e `pnpm build` passaram. `pnpm db:migrate` passou com a ligação PostgreSQL configurada. O servidor local respondeu com `status=ok` e `database=connected`. `MAVUNO_RUN_INTEGRATION_TESTS=1 pnpm test:integration` passou com 50 verificações, duas sessões Socket.IO e remoção das 2 contas temporárias criadas. O teste confirmou o endpoint de voz como indisponível porque as variáveis LiveKit não estavam configuradas; não testou áudio real. Docker, publicação externa, LiveKit com dispositivos físicos e áudio bidirecional continuam não verificados. O driver avisou que `sslmode=require` terá semântica diferente numa versão futura; para produção, preferir `sslmode=verify-full` quando suportado pelo fornecedor.

## Execução e publicação por container

O `Dockerfile` compila cliente/servidor e inicia `node dist/server/index.mjs`. `.dockerignore` exclui `.env` e outros ficheiros de ambiente. Na máquina de build:

```bash
docker build -t mavuno:latest .
```

Antes do primeiro arranque, aplicar as migrações à instância PostgreSQL de produção a partir de um processo administrativo controlado (`pnpm db:migrate` com `POSTGRES_URL` de produção). Não aplicar migrações automaticamente em cada arranque concorrente.

Publicar a imagem num serviço de containers compatível e configurar no runtime os segredos `POSTGRES_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` (os últimos três apenas para voz), além de `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=none`, `NODE_ENV=production` e a porta fornecida pelo alojamento (`PORT`, por omissão 3000). Disponibilizar HTTPS no edge/reverse proxy, encaminhar o tráfego para a porta do container e configurar `GET /api/health` como verificação de saúde sem autenticação. A aplicação não precisa de volume local durável: os dados ficam no PostgreSQL.

Não publicar segredos em imagens, logs, ficheiros de configuração versionados ou no bundle do navegador. O deployment não tem sido executado neste projeto; validar DNS/HTTPS, credenciais e saúde no alojamento escolhido antes de abrir acesso aos utilizadores.

O sandbox usado nesta entrega não inclui Docker CLI; por isso, o build da imagem container não foi verificado neste ambiente. O build TypeScript/Vite foi executado com sucesso.

## Organização do código

```text
src/client/             UI React, API HTTP, estilos e entrada PWA
src/server/             Express, autenticação, permissões, API e Socket.IO
src/server/db/          esquema PostgreSQL Drizzle e cliente
public/                 ícones, manifesto, service worker e rotas
drizzle/                 migrações SQL versionadas
 tests/                  testes unitários e smoke test opt-in
```

## Pontos de extensão documentados

Adicionar, quando houver requisitos/configuração: volume individual por participante; cancelamento de ruído e melhorias de áudio; palco com oradores/ouvintes; fóruns e tópicos; upload seguro de imagens, vídeos, GIFs e ficheiros; cargos personalizados; notificações push; ferramentas avançadas de moderação; e integração de engenharia reversa (por exemplo, REA) no ambiente de desenvolvimento. Estas funções não estão implementadas nesta versão.

## Estado final — 2026-10-31

Foram acrescentados menus contextuais de mensagens e membros, engrenagem de administração, regras da comunidade, mensagens fixadas, silenciamentos temporários, expulsão, banimento, revogação de banimento, auditoria server-side e o fluxo de chamadas privadas entre membros. As chamadas usam Socket.IO para convite e estados, e LiveKit para áudio quando as credenciais do servidor estiverem configuradas.

A verificação final passou `pnpm typecheck`, `pnpm test` (4/4) e `pnpm build`. O smoke test de integração passou anteriormente com 65 verificações e as migrações PostgreSQL passaram. O áudio real entre dispositivos ainda não foi validado porque LiveKit não estava configurado.

O módulo multimédia e AutoMod recebido em 2026-10-31 permanece pendente: não declarar upload de anexos, reações persistentes, emojis/stickers personalizados, capacidades por canal ou deteção automática de conteúdo como funcionais até existir backend, armazenamento seguro, validação, permissões e testes reais. Também não existe serviço externo de classificação de conteúdo integrado.
