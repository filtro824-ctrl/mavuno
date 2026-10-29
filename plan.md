# Plano de implementação — Mavuno

## Objetivo e limites

Construir uma primeira versão funcional, pequena e extensível de uma plataforma web de comunidades e conversas, com identidade própria. A experiência privilegia telemóveis Android modestos e ligações lentas. As funções dependentes de serviços externos só serão declaradas concluídas depois de realmente testadas. As funções avançadas permanecem pontos de extensão documentados, não funcionalidades simuladas.

## Arquitetura e decisões técnicas

- **Cliente:** React 19, TypeScript e Vite, com JSX automático do esbuild e CSS próprio. O Fast Refresh foi removido porque o seu preâmbulo JavaScript inline era bloqueado pela CSP/Preview; o cliente mantém os módulos Vite sem injeção inline. React é mantido como dependência de UI, não como uma camada de componentes pesados. A voz LiveKit é importada sob demanda.
- **Servidor:** Node.js/TypeScript, Express 4, Zod, Helmet e `express-rate-limit`. Express serve a SPA compilada, API, recursos PWA e Socket.IO a partir da mesma origem. Em produção respeita `PORT` (3000 por omissão). Respostas API contêm `Cache-Control: private, no-store`.
- **Autenticação:** email/nome/palavra-passe; `scrypt` da biblioteca padrão armazena hashes com salt; tokens opacos de sessão guardam apenas digest na base de dados; cookies HttpOnly. Para HTTPS Preview cross-site: `SameSite=None; Secure`, configurado por opções explícitas e não inferido do protocolo interno. Operações mutáveis exigem CSRF e cada ação sensível valida autorização no servidor. CSP mantém scripts `'self'`; permite o enquadramento Preview com `frame-ancestors` e não envia `X-Frame-Options` impeditivo.
- **Dados:** PostgreSQL externo via `POSTGRES_URL`, Drizzle ORM e migrations SQL versionadas. A plataforma gerida disponibilizada no init é MySQL; por isso não se usa `DATABASE_URL` gerido para esta decisão PostgreSQL. O driver respeita o `sslmode` da URL e não desativa validação de certificados; para alojamento remoto, `.env.example` indica `sslmode=verify-full`. Esquema inclui utilizadores, sessões, comunidades, membros, cargos/permissões, canais, mensagens/menções, convites e configuração de voz, com chaves estrangeiras, índices e unicidade. A primeira migração foi aplicada. A recuperação depende de fornecedor de email; sem ele, o endpoint devolve indisponível de forma explícita.
- **Tempo real e idempotência:** Socket.IO autenticado por sessão; validar membership antes e depois de entrar na sala/canal e retirar membros removidos. Persistir antes de emitir. A API limita o histórico e usa cursor estável por timestamp+ID. `clientMessageId` permite deduplicar após nova tentativa; UI apresenta estados `sending`/`failed` e permite retry com o mesmo identificador. Quando o socket reconecta, busca a página recente e mescla por IDs existentes para reconciliar mensagens perdidas sem duplicá-las.
- **Voz:** o SDK de servidor LiveKit gera tokens autorizados de curta duração; a UI usa LiveKit real e indica participantes ligados, microfone e entrada/saída. O endpoint assinado foi exercitado. Ainda não se validou um fluxo de áudio real em contas/dispositivos distintos; essa capacidade mantém-se parcial.
- **PWA/cache:** manifesto instalado, ícones próprios SVG e PNG 192/512 e service worker versionado. Cacheia somente shell/recursos estáticos same-origin; ignora API, sessão e Socket.IO. Offline completo não é prometido. Mensagens/conversas não ficam em cache pública.
- **Deploy:** Dockerfile multistage constrói frontend/backend; a imagem lê segredos só no runtime, honra `PORT` e expõe `/api/health`. `README.md` explica migrações, HTTPS, LiveKit, testes e publicação. Não se considera a aplicação publicada até à confirmação efetiva do serviço escolhido.

## Estrutura real do projeto

```text
mavuno/
├── app.config.ts             # metadata do logótipo Manus
├── package.json              # dependências fixadas e comandos pnpm
├── pnpm-lock.yaml            # resolução reprodutível
├── pnpm-workspace.yaml       # scripts de instalação permitidos
├── .env.example              # nomes e valores de exemplo, sem credenciais
├── .gitignore / .dockerignore
├── Dockerfile                # imagem de build/runtime
├── drizzle.config.ts         # Drizzle Kit e POSTGRES_URL
├── drizzle/                  # migrations PostgreSQL versionadas
├── public/                   # manifesto, SW, ícones, rotas
├── src/
│   ├── client/
│   │   ├── App.tsx           # auth, comunidades, mensagens, cargos e LiveKit
│   │   ├── api.ts            # cliente HTTP e tipos partilhados do cliente
│   │   ├── main.tsx          # bootstrap React e registo PWA
│   │   ├── index.html        # shell e metadados
│   │   └── styles.css        # tema escuro acessível/responsivo
│   └── server/
│       ├── index.ts          # servidor, headers, Socket.IO e serving
│       ├── api.ts            # autenticação, comunidades, canais, mensagens e voz
│       ├── security.ts       # hashing, sessões e CSRF
│       ├── permissions.ts    # autorização e roles
│       ├── roles.ts          # tipos das funções/cargos
│       └── db/               # schema Drizzle e ligação PostgreSQL
└── tests/
    ├── security.test.ts      # testes unitários, sem banco
    └── integration-smoke.ts  # opt-in, dois utilizadores e limpeza dirigida
```

## Design e experiência

- **Movimento estético:** wayfinding editorial moderno reinterpretado como um console comunitário noturno: a navegação fica ancorada à esquerda, a conversa conserva o maior plano visual e os controlos são discretos.
- **Princípios centrais:** conteúdo da conversa primeiro; hierarquia previsível; controlos táteis; estados de rede honestos; pouco peso visual e de transferência.
- **Filosofia de cor:** grafite verde profundo reduz brilho e cria continuidade entre ecrãs; superfícies em verde-carvão separam regiões sem cartões decorativos; o mint turquesa destaca somente ação, presença e seleção; erro coral fica reservado a falhas.
- **Layout:** desktop com rail estreita de comunidades, painel contextual de canais/membros e conversa expansiva; no telemóvel, rail compacta e transição entre painel/canais e conversa, com controlo rápido flutuante afastado da área segura.
- **Elementos de assinatura:** marca M geométrica com ponto mint; barra mint estreita no canal ativo; botão móvel quadrado-arredondado que recolhe parcialmente após inatividade.
- **Interação:** estados locais imediatos com confirmação do servidor; envio falhado permanece explícito e repetível com a mesma chave idempotente; sem fingir presença ou voz. Acessibilidade por etiquetas semânticas, foco e `prefers-reduced-motion`.
- **Animação:** transições curtas apenas para mudança de estado; recolher o botão após 3,6 s sem interação; nenhuma animação contínua; desativar movimento não essencial com `prefers-reduced-motion`.
- **Tipografia:** `system-ui` como família principal para evitar fonte remota e reduzir bytes em Android; hierarquia curta por peso/tamanho, com `ui-monospace` apenas para metadados técnicos quando necessário.
- **Essência da marca:** “Comunidades e conversas leves para quem precisa de um espaço claro, mesmo em ligações modestas.” Personalidade: prática, acolhedora e confiável.
- **Voz:** mensagens curtas, humanas e honestas quanto ao estado. Exemplos: “Continua a conversa.” / “A mensagem falhou. Tenta novamente.”
- **Wordmark/logótipo:** glifo SVG M minúsculo geométrico com um ponto circular de encontro no quadrante superior direito; não usa lettering padrão nem referência visual de outra plataforma.
- **Cor proprietária:** mint `#70E0B0`, reservado a estados ativos e ações-chave.

## Dependências e limites externos

`POSTGRES_URL` precisa apontar para PostgreSQL com validação TLS e `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` são necessários para voz real. Nenhuma credencial fica no repositório ou bundle cliente. A recuperação de palavra-passe precisa de fornecedor de email não configurado. Avatares são URL externa; upload de ficheiros, volume individual, palco, fóruns, cargos personalizados, push e moderação avançada estão documentados como extensões, não como funcionalidades desta versão.
