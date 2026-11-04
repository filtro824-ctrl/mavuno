# Mavuno: guia para continuar o desenvolvimento

## 1. Regras de trabalho (obrigatórias)
- Um pedido de cada vez. Cada etapa termina com commit no GitHub (e o link do commit), e o deploy é feito pelo dono do projeto.
- NUNCA uses nem ligues o Render. O serviço chama-se mavuno-qfed (mavuno-qfed.onrender.com). O deploy é do dono.
- A base de dados é PostgreSQL no Supabase e tu NÃO tens acesso. Nunca peças nem uses o POSTGRES_URL. Nunca corras pnpm db:migrate nem pnpm test:integration: o histórico do Drizzle não está aplicado no Supabase e o teste de integração cria e apaga contas.
- Nunca apagar, repor ou recriar dados existentes. Se uma alteração parecer mexer em contas, comunidades, canais ou mensagens, parar e avisar o dono antes de continuar.
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
- Alojamento: Render, Web Service mavuno-qfed. Variáveis de ambiente (só os nomes): POSTGRES_URL, COOKIE_SECURE, COOKIE_SAME_SITE, NODE_ENV, PG_POOL_SIZE; de voz: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (ainda por configurar); de anexos: STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_REGION, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY.
- Base de dados: PostgreSQL no Supabase, ligada pelo Session pooler. Row Level Security ativo nas tabelas.

## 3. Stack e estrutura (verifica no código)
React/Vite, TypeScript, Express, Socket.IO, PostgreSQL com Drizzle, LiveKit para voz, PWA. Ficheiros principais: src/client/App.tsx, api.ts, styles.css, emoji-data.ts; src/server/index.ts, api.ts, security.ts, permissions.ts, profile-utils.ts, profile-realtime.ts, db/schema.ts; public/service-worker.js; drizzle/; tests/. Comandos: pnpm typecheck, pnpm test, pnpm build.

## 4. Estado atual
Etapa 8 concluída no código: servidor e interface de emojis personalizados, stickers de comunidade e stickers em mensagens, incluindo o Pacote Mavuno (30 stickers e 8 emojis). Inclui seletores, pesquisa, mensagens com emojis/stickers, reações, autocompletar, atualização em tempo real e gestão/envio múltiplo com permissões. A migração 0013 foi aplicada pelo dono no Supabase; não foi alterado novamente o esquema.
Etapa 9 concluída no código: escolha de fotografia no dispositivo, editor de recorte circular para o perfil e enquadramento largo para o fundo, ajuste por arrasto/toque e zoom, pré-visualização, cancelar/concluir e envio para o bucket S3 privado existente. Os links HTTPS já guardados mantêm-se até o utilizador guardar uma substituição. Não foi alterado o esquema nem o SQL aplicado.
O botão flutuante de conversas rápidas pode ser arrastado e encaixa na lateral mais próxima; a posição lateral e vertical é guardada neste aparelho, o botão recolhe após 10 segundos sem uso e pode ser reposicionado por toque, rato ou teclado.
Etapa 10 concluída no código: convites com durações e limites configuráveis, pré-visualização pública sem sessão em /invite/<código>, regras com aceitação obrigatória, mensagem de boas-vindas, entrada pública por pedido opcional, gestão e revogação de convites, aprovação/recusa/cancelamento de pedidos, cooldown de 24 horas, limite de 20 pedidos pendentes por utilizador, avisos em tempo real e permissões verificadas no servidor. Migração 0011 aplicada pelo dono; não foi alterado novamente o SQL aplicado.
Feito no código: registo, login, sessões, comunidades públicas e privadas, convites, cargos e permissões, canais, mensagens em tempo real, respostas, menções, fixar, silenciar, expulsar e banir, auditoria, chamadas privadas e salas de voz via LiveKit (sem teste real de áudio), reações persistentes com seletor de emojis (commit 81697b0), redesign visual e correção de layout com zoom (commit 74e474a), perfil com controlo de privacidade (commit 3ed4fdd). Etapa 4 concluída: menu unificado para mensagens e membros, silenciamento temporário, expulsão e banimentos temporários/permanentes; aguarda deploy do dono. Etapa 5 concluída: barra do utilizador com microfone, auscultadores, definições e menus responsivos; preferências de áudio locais, teste de microfone, integração com voz/chamadas e correção da altura da lista de mensagens. Etapa 6 concluída: cartão de perfil compacto e expansível, banner por link ou cor de fallback, texto e preferência de presença, presença invisível tratada como offline no servidor, privacidade de banner/estado, editor por separadores, pré-visualização, validação HTTPS e testes unitários; aguarda deploy do dono. Etapa 7 concluída no código: armazenamento S3 privado, rotas protegidas, validação/quotas, envio, visualização, descarregamento, renovação de URLs, limpeza de anexos, pré-visualizações, compressão local de imagens e testes; migração 0010 aplicada pelo dono. Aguarda configuração do bucket privado e deploy pelo dono.
Etapa 11 concluída no código: categorias de canais recolhíveis e ordenáveis, contagens e avisos de não lidas em tempo real, canais só de leitura com permissões verificadas no servidor, capa de comunidade com cor de reserva e lista de banimentos ativos com revogação. Migração 0012 aplicada pelo dono; não foi alterado novamente o SQL aplicado.
Etapa 13 em curso: esquema aditivo de mensagens privadas concluído no código; migração 0014 aplicada pelo dono. Servidor e interface das DMs ainda por implementar.
Ainda NÃO existe: AutoMod, notificações push, recuperação de conta por email, planos e pagamentos.

## 5. SQL já aplicado no Supabase (por ordem)
1. Migrações 0000 a 0006 coladas juntas, sem as linhas "--> statement-breakpoint" (18 tabelas, incluindo message_reactions).
2. ALTER TABLE ... ENABLE ROW LEVEL SECURITY nas 18 tabelas.
3. Migração 0007: 7 colunas na tabela users (about_me, show_avatar, show_about, show_status, show_join_date, show_common_communities, show_email).
4. Migração 0008, aplicada pelo dono: coluna nullable community_bans.expires_at (timestamp with time zone).
5. Migração 0009, aplicada pelo dono: banner_url, banner_color, status_text, presence_preference e show_banner na tabela users.
6. Migração 0010, aplicada pelo dono: nova tabela message_attachments, índices message_id/user_id e RLS ativo.
7. Migração 0011, aplicada pelo dono: colunas welcome_message e require_approval em communities, rules_accepted_at em community_members, revoked_at em invitations, tabela join_requests com índices e RLS ativo.
8. Migração 0012, aplicada pelo dono: categorias de canais, posição e leitura em channels, tabela channel_reads com RLS e campos de capa em communities.
9. Migração 0013, aplicada pelo dono: tabelas custom_emojis, stickers e message_stickers com índices e RLS ativo; alargamento de message_reactions.emoji para varchar(64).
10. Migração 0014, aplicada pelo dono: novas tabelas direct_conversations, direct_messages, direct_reads e dm_blocks, com chaves, índices, checks e RLS. Não voltar a alterar esta migração ou o esquema aplicado.
Nota: o ajuste do botão flutuante e a etapa 9 não alteram o esquema; a etapa 10 usa a migração 0011, a etapa 11 usa a migração 0012, o esquema da etapa 8 usa a migração 0013 e o esquema da etapa 13 usa a migração 0014, aplicadas pelo dono. A etapa 9 e a etapa 8 usam o bucket privado já previsto, cuja configuração e regra de ciclo de vida continuam a cargo do dono.

## 6. Fila de etapas (o dono envia o pedido de cada uma, por esta ordem)
4 Menu das mensagens ao premir (sem os três pontos), silenciar e banir por tempo. SQL (1 coluna: community_bans.expires_at).
5 Barra do utilizador (microfone, auscultadores, engrenagem, Definições) e correção da lista de mensagens no modo PC. Sem SQL — concluída nesta etapa.
6 Cartão de perfil expansível, imagem de fundo por link, estado e texto de estado. SQL — concluída nesta etapa.
7 Anexos (imagens, GIFs, vídeos, documentos) com armazenamento S3 compatível — concluída no código; exige bucket privado criado e configurado pelo dono.
8 Emojis personalizados e stickers. SQL.
9 Foto de perfil e imagem de fundo enviadas do telemóvel — concluída no código, sem SQL.
10 Convites, boas-vindas com regras e pedidos de entrada — concluída nesta etapa, migração 0011 aplicada.
11 Categorias de canais, não lidas, canais só de leitura, capa da comunidade, lista de banimentos ativos — concluída no código; migração 0012 aplicada pelo dono.
12 Pré-visualização de links.
13 Mensagens privadas (DMs). SQL.
14 Favoritar, denunciar, encaminhar, copiar link, marcar como não lido. SQL.
15 Chamadas: bolha flutuante, avisos de entrada e saída, chamada a receber.
16 Voz real testada com dois telemóveis (configuração do dono com LiveKit).
17 AutoMod. SQL.
18 Notificações com o Mavuno fechado. SQL.
Prioridade: 4, 5, 6, 7, 10, 8 e 9 concluídas. Etapa 13 em curso (migração 0014 aplicada; servidor e interface pendentes). Próxima etapa após concluir DMs: 12 (pré-visualização de links). Fora da fila: recuperação de conta por email, planos e pagamentos, app nativa.

## 7. Limitações conhecidas
Voz sem LiveKit configurado e sem teste com dois aparelhos; anexos e fotos de perfil dependem da configuração do bucket privado no Render e da regra de ciclo de vida para profile-upload-pending/; sem recuperação de conta por email; sem planos nem pagamentos; sem notificações push.
