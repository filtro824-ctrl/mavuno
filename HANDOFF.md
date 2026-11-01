# Mavuno: guia para continuar o desenvolvimento

## 1. Regras de trabalho (obrigatórias)
- Um pedido de cada vez. Cada etapa termina com commit no GitHub (e o link do commit), e o deploy é feito pelo dono do projeto.
- NUNCA uses nem ligues o Render. O serviço chama-se mavuno-qfed (mavuno-qfed.onrender.com). O deploy é do dono.
- A base de dados é PostgreSQL no Supabase e tu NÃO tens acesso. Nunca peças nem uses o POSTGRES_URL. Nunca corras pnpm db:migrate nem pnpm test:integration: o histórico do Drizzle não está aplicado no Supabase e o teste de integração cria e apaga contas.
- Fluxo de cada alteração à base de dados: gerar a migração com pnpm db:generate; retirar instruções antigas que apareçam por causa dos snapshots; mostrar o SQL completo em texto; PARAR; o dono cola o SQL no SQL Editor do Supabase e diz "Apliquei o SQL"; só então fazes commit. Só alterações ADITIVAS (colunas novas com valor por defeito, tabelas novas, índices novos). Toda a tabela nova leva no SQL a linha ALTER TABLE ... ENABLE ROW LEVEL SECURITY.
- Antes de cada commit mostra git status e git diff --stat. Se aparecer algo fora do âmbito (ícones, .env, Dockerfile, package.json sem motivo, ficheiros temporários), pára e avisa.
- Nunca imprimas nem copies o .env nem segredos. Sem segredos no repositório.
- O ícone do Mavuno ("m" verde: public/icon.svg, icon-192.png, icon-512.png e favicon) nunca muda.
- Sem bibliotecas novas, exceto o SDK S3 (@aws-sdk/client-s3 e @aws-sdk/s3-request-presigner, versões fixas) na etapa de anexos.
- Em cada etapa: atualizar a versão da cache em public/service-worker.js e apagar caches antigas na ativação; correr pnpm typecheck, pnpm test e pnpm build; textos em português simples, sem termos técnicos na interface; privacidade e permissões aplicadas no servidor, não só no ecrã; layouts testados a 360px, 430px, 980px (modo PC) e com zoom de 150%; sem barra de rolagem horizontal a 360px.
- No fim de cada etapa: o que ficou feito, o que não foi possível (com o motivo exato) e o link do commit. Atualiza as secções 4 e 5 deste ficheiro no mesmo commit da etapa.
- Se os créditos estiverem a acabar, faz commit numa branch separada (etapaN-wip) e diz-me.

## 2. Onde está cada coisa
- Código: GitHub filtro824-ctrl/mavuno, branch main (público). É a fonte de verdade.
- Alojamento: Render, Web Service mavuno-qfed. Variáveis de ambiente (só os nomes): POSTGRES_URL, COOKIE_SECURE, COOKIE_SAME_SITE, NODE_ENV, PG_POOL_SIZE; de voz: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (ainda por configurar).
- Base de dados: PostgreSQL no Supabase, ligada pelo Session pooler. Row Level Security ativo nas tabelas.

## 3. Stack e estrutura (verifica no código)
React/Vite, TypeScript, Express, Socket.IO, PostgreSQL com Drizzle, LiveKit para voz, PWA. Ficheiros principais: src/client/App.tsx, api.ts, styles.css, emoji-data.ts; src/server/index.ts, api.ts, security.ts, permissions.ts, profile-utils.ts, profile-realtime.ts, db/schema.ts; public/service-worker.js; drizzle/; tests/. Comandos: pnpm typecheck, pnpm test, pnpm build.

## 4. Estado atual
Feito e no ar: registo, login, sessões, comunidades públicas e privadas, convites básicos, cargos e permissões, canais, mensagens em tempo real, respostas, menções, fixar, silenciar, expulsar e banir (sem tempo), auditoria, chamadas privadas e salas de voz via LiveKit (sem teste real de áudio), reações persistentes com seletor de emojis (commit 81697b0), redesign visual e correção de layout com zoom (commit 74e474a), perfil com controlo de privacidade (commit 3ed4fdd).
Ainda NÃO existe: menu de ações estilo Discord com silenciar e banir por tempo (etapa 4), barra do utilizador com microfone e auscultadores, cartão de perfil expansível, anexos, emojis personalizados e stickers, mensagens privadas (DMs), categorias de canais, AutoMod, notificações push, recuperação de conta por email, planos e pagamentos.

## 5. SQL já aplicado no Supabase (por ordem)
1. Migrações 0000 a 0006 coladas juntas, sem as linhas "--> statement-breakpoint" (18 tabelas, incluindo message_reactions).
2. ALTER TABLE ... ENABLE ROW LEVEL SECURITY nas 18 tabelas.
3. Migração 0007: 7 colunas na tabela users (about_me, show_avatar, show_about, show_status, show_join_date, show_common_communities, show_email).
(A etapa 4 ainda NÃO tem SQL aplicado. A migração seguinte será a 0008.)

## 6. Fila de etapas (o dono envia o pedido de cada uma, por esta ordem)
4 Menu das mensagens ao premir (sem os três pontos), silenciar e banir por tempo. SQL (1 coluna: community_bans.expires_at).
5 Barra do utilizador (microfone, auscultadores, engrenagem, Definições) e correção da lista de mensagens no modo PC. Sem SQL.
6 Cartão de perfil expansível, imagem de fundo por link, estado e texto de estado. SQL.
7 Anexos (imagens, GIFs, vídeos, documentos) com armazenamento S3 compatível. SQL. Exige bucket privado criado pelo dono.
8 Emojis personalizados e stickers. SQL.
9 Foto de perfil e imagem de fundo enviadas do telemóvel.
10 Convites, boas-vindas com regras e pedidos de entrada. SQL.
11 Categorias de canais, não lidas, canais só de leitura, capa da comunidade, lista de banimentos ativos. SQL.
12 Pré-visualização de links.
13 Mensagens privadas (DMs). SQL.
14 Favoritar, denunciar, encaminhar, copiar link, marcar como não lido. SQL.
15 Chamadas: bolha flutuante, avisos de entrada e saída, chamada a receber.
16 Voz real testada com dois telemóveis (configuração do dono com LiveKit).
17 AutoMod. SQL.
18 Notificações com o Mavuno fechado. SQL.
Prioridade: 4, 5, 6, 7 e 10; depois 8, 9, 11 e 13. Fora da fila: recuperação de conta por email, planos e pagamentos, app nativa.

## 7. Limitações conhecidas
Voz sem LiveKit configurado e sem teste com dois aparelhos; sem upload de ficheiros; sem recuperação de conta por email; sem planos nem pagamentos; sem notificações push.
