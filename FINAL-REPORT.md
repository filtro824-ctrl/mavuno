# Mavuno — relatório final de verificação e entrega

Data da verificação: 2026-10-29

## Resultado geral

O projeto foi mantido a partir do estado recebido. Não foram removidas funcionalidades existentes nem introduzidos dados fictícios, credenciais reais ou uma implementação de pagamentos não suportada pela documentação oficial disponível.

A versão é instalável e compilável. A voz LiveKit permanece parcial: o backend e o cliente estão integrados, mas o áudio real entre dois dispositivos não foi comprovado neste ambiente. A publicação externa também não foi executada.

Foi preparado um `.env` local vazio para configuração manual. O ficheiro é ignorado pelo Git e pelo Docker, não é incluído no ZIP e não contém qualquer credencial. `drizzle.config.ts` passou a carregar explicitamente `.env`, alinhando as migrações com o carregamento já usado pelo servidor e pelo smoke test.

## Funcionalidades concluídas no estado entregue

- Registo, login, logout, sessões com cookies HttpOnly, CSRF e hashing scrypt.
- Perfis com username e avatar por URL HTTPS.
- Comunidades públicas e privadas, canais, convites, entrada e saída.
- Cargos owner/admin/moderator/member e autorização aplicada no backend.
- Mensagens persistentes em PostgreSQL, paginação, respostas, menções e idempotência por `clientMessageId`.
- Tempo real por Socket.IO com verificação de membership e remoção de acesso de membros expulsos.
- Estados de ligação, reconexão e retry no cliente.
- PWA com manifesto, ícones, service worker limitado ao shell estático e sem cache de API/sessões.
- Integração LiveKit existente: criação de sala/registo, emissão de token curto no servidor e carregamento real do cliente sob demanda.
- Migração Drizzle/PostgreSQL, Dockerfile multistage e `.env.example` sem segredos.
- Correção preservada do preâmbulo Vite/React: JSX automático sem preâmbulo inline de Fast Refresh, compatível com a CSP configurada e o Preview.

## Testes executados nesta continuação

| Comando | Resultado |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passou; lockfile aceite e dependências instaladas com pnpm 11.25.0 |
| `pnpm typecheck` | Passou |
| `pnpm test` | Passou: 4/4 testes de segurança |
| `pnpm build` | Passou: build Vite do cliente e bundle esbuild do servidor |
| `pnpm db:migrate` | Passou; ligação ao PostgreSQL confirmada e migrações aplicadas |
| `GET /api/health` | Passou; servidor local confirmou `status=ok` e `database=connected` |
| `MAVUNO_RUN_INTEGRATION_TESTS=1 pnpm test:integration` | Passou: 50 verificações, duas sessões Socket.IO e limpeza de 2 contas temporárias; LiveKit foi verificado apenas como não configurado |
| `docker build` | Não executado: Docker CLI não está disponível no sandbox |

O smoke test usou a base PostgreSQL configurada pelo utilizador e removeu as 2 contas temporárias criadas pelo teste. O driver emitiu um aviso sobre a semântica futura de `sslmode=require`; a ligação atual funcionou, mas recomenda-se migrar futuras configurações para `sslmode=verify-full` quando compatível com o fornecedor.

## Voz LiveKit: o que está e o que falta

Está implementada a proteção do token no backend, a validação de autorização/membership e a configuração por `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`. Sem essas três variáveis, o endpoint responde explicitamente como indisponível, sem simular uma chamada.

Falta testar com duas contas em dois dispositivos reais ou em dois navegadores com microfones distintos: autorização do microfone, entrada, saída, mute/unmute, presença dos participantes, áudio nos dois sentidos, perda/reconexão de rede e encerramento limpo da sala. Esses testes exigem credenciais LiveKit válidas, HTTPS e dispositivos com microfone/saída de áudio.

## Planos Free/Pro

Não existe no código recebido uma implementação de subscrições Free/Pro, limites de utilização, estado de cobrança, concessão ou renovação. Portanto nenhum plano é apresentado como pago ou ativo. A implementação futura deve aplicar limites no backend e não apenas ocultar controlos na interface.

## iMali Way e pagamentos

A documentação pública consultada da iMaliPay descreve uma API única, ferramentas de teste e acesso mediante demonstração, mas não expõe na página pública consultada endpoints, payloads, webhooks ou credenciais suficientes para uma integração verificável: <https://www.imalipay.com/developers>.

O projeto não inventa endpoints nem resultados de pagamentos. A ativação futura deverá ser feita em Sandbox, manter segredos exclusivamente no backend, guardar transações e estados, usar idempotência, validar notificações server-to-server e só ativar/renovar Pro depois de confirmação válida. M-Pesa e cartões Visa/Mastercard continuam dependentes da documentação, aprovação e credenciais fornecidas pela iMali Way.

## Pendências para publicação

1. Para publicação, manter PostgreSQL persistente com TLS validado (`sslmode=verify-full`) e repetir `pnpm db:migrate` num processo administrativo controlado.
2. Configurar LiveKit e executar os testes físicos de voz descritos acima.
3. Configurar domínio, HTTPS no edge/reverse proxy, WebSocket forwarding e health check em `/api/health`.
4. Executar o build Docker num ambiente com Docker e verificar o arranque da imagem.
5. Configurar fornecedor de email se for necessária recuperação de conta.
6. Definir e implementar oficialmente os planos Free/Pro, limites e billing antes de expor subscrições.
7. Obter acesso autorizado à iMali Way, confirmar documentação de Sandbox/webhooks e implementar a integração com testes sem dinheiro real.

Não foi declarada publicação externa, funcionamento completo da voz ou pagamentos ativos.
