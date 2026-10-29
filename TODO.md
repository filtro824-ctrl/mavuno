# TODO — Mavuno

Este quadro preserva as condições de aceitação da especificação original. `[x]` significa implementação comprovada; `[ ]` significa pendente ou parcial e não deve ser apresentada como concluída.

## 1. Contas de utilizador

- [x] Implementar registo, início de sessão e encerramento de sessão; perfil com nome de utilizador e avatar; senhas armazenadas através de hash seguro; sessões protegidas e validação no servidor. **Evidência:** duas contas de teste, login/logout, alteração de nome/avatar, cookie `Secure; SameSite=None`, sessão restaurada no browser, testes scrypt/tokens.
- [ ] Implementar recuperação de conta quando estiver configurado o serviço de email. **Estado:** serviço de email ainda não configurado; API informa indisponibilidade sem simular envio.

## 2. Comunidades

- [x] Criar comunidades públicas ou privadas; entrar numa comunidade através de um convite; sair de uma comunidade; ver os membros e os canais disponíveis; definir proprietário e administradores. **Evidência:** integração criou ambas, escondeu detalhes privados a não membros, convidou/juntou a segunda conta e testou a saída voluntária; interface lista membros, canais e cargos.

## 3. Canais de texto

- [x] Criar canais e organizar os assuntos; enviar, receber e guardar mensagens na base de dados; atualizar conversas em tempo real; mostrar autor e hora; permitir responder e mencionar utilizadores; paginar o histórico para evitar carregar milhares de mensagens de uma só vez. **Evidência:** duas sessões Socket.IO, mensagem gravada/recebida, menções/respostas, cursor estável e limite por página; UI volta a exibir a mensagem depois de reload completo.
- [x] Mostrar estados de carregamento, erros e reconexão; tentar nova entrega com o mesmo identificador idempotente para evitar duplicação. **Evidência:** estados `A enviar…`/`Falhou enviar`, ação “Tentar novamente”, reconexão Socket.IO, ressincronização da página recente mesclada por ID sem duplicados e teste Chromium com mensagem criada durante o offline.

## 4. Canais de voz — parcial

- [ ] Implementar uma primeira versão **testada** de comunicação de áudio real, não apenas ecrã com botões.
- [x] Preparar criação/configuração de salas de voz, tokens LiveKit curtos gerados no servidor e validação da autorização antes de entrar; cliente LiveKit real carrega sob demanda.
- [ ] Comprovar entrada/saída de sala, ativação/silêncio do microfone, participantes e áudio simultâneo com contas diferentes e dispositivos diferentes; não simular participantes ou ligações bem-sucedidas. **Evidência atual:** endpoint de token assinado testado; áudio real entre dispositivos e saída não testados. Manter voz assinalada como parcial.
- [x] Documentar as credenciais/serviço externo necessários (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`) e identificar o que falta. Não afirmar voz funcional antes do teste real.

## 5. Cargos e permissões

- [x] Implementar proprietário, administrador, moderador e membro; verificar permissões no backend, não apenas escondê-las na interface; permitir que utilizadores autorizados gerenciem canais, apaguem mensagens e expulsem membros de acordo com permissões. **Evidência:** matriz de permissões exercitada na integração; mutações não autorizadas são recusadas.

## 6. Descoberta de comunidades

- [x] Criar página para explorar comunidades públicas; permitir pesquisa por nome ou categoria; criar páginas/detalhes de comunidade; permitir entrada através de convite, respeitando as regras de acesso. **Evidência:** busca da integração encontra comunidade pública, exclui privada, carrega detalhes e usa convite para associação.

## 7. Ícone flutuante para telemóveis

- [x] Implementar botão flutuante com identidade própria que abre painel rápido de conversas; após alguns segundos sem interação, recolhe-se parcialmente para a lateral; ao tocar, reaparece e abre o painel; respeita safe areas e não bloqueia controlos essenciais; é leve e funciona em ecrãs pequenos.
- [x] Mantê-lo dentro da plataforma web; não implementar nem alegar sobreposição sobre outros aplicativos Android. **Evidência:** teste Chromium a 390 px observou recolha após 3,6 s (52 px visíveis), toque e abertura do painel.

## 8. Design e experiência de utilização

- [x] Criar identidade visual original, moderna e profissional; tema escuro inicial; navegação simples e consistente; desktop com comunidades, canais e conversa; telemóvel com navegação compacta e painéis abertos/fechados; evitar animações excessivas, imagens decorativas pesadas e efeitos desnecessários; garantir legibilidade, acessibilidade e controlos táteis adequados; não reproduzir logótipo/identidade do Discord. **Evidência:** captura Chromium em 1440×900 e 390×844; ambos sem overflow horizontal; `prefers-reduced-motion` respeitado.
- [x] Incluir PWA instalável por manifesto, ícones SVG/PNG 192/512 e service worker versionado que cacheia apenas recursos estáticos adequados; não guardar dados privados em cache pública. Não prometer offline completo. **Evidência:** Chromium ativou o service worker, leu manifest `standalone`, decodificou os PNG 192/512 e serviu ícone em modo offline; `/api/health` não foi cacheado.

## 9. Otimização para internet lenta

- [x] Carregar primeiro interface/conteúdo essencial; evitar transferências repetidas; paginar mensagens; reduzir recursos estáticos; mostrar falha de ligação e estados de mensagem enviada/pendente/falhada; tentar restabelecer ligação sem duplicar mensagens; carregar LiveKit sob demanda; usar cache estático seguro.
- [ ] Upload de ficheiros não está disponível nesta versão; portanto não existem uploads para paginar/carregar sob demanda ou validar por tipo/tamanho. Avatares aceitam URL externa. Implementar limites de ficheiros antes de introduzir uploads.

## 10. Base de dados relacional

- [x] Usar PostgreSQL escolhido através de `POSTGRES_URL`, via TLS com certificado validado (`sslmode=verify-full` recomendado); criar migrações com chaves estrangeiras, índices, unicidade e restrições; incluir Users, Sessions (equivalentes), Communities, CommunityMembers, Roles, Permissions, Channels, Messages, Invitations e VoiceRooms/configuração equivalente.
- [x] Definir relações/regras de acesso, evitar duplicação desnecessária e garantir que utilizador sem associação não consulta mensagens/canais privados. **Evidência:** migration PostgreSQL aplicada; integração confirmou recursos privados inacessíveis a não membros e limpeza dirigida das linhas de teste.

## 11. Segurança e moderação

- [x] Validar entradas cliente/servidor; bloquear acesso não autorizado; aplicar rate limiting; proteger contra XSS, CSRF quando aplicável e injeção; validar permissões em operações sensíveis; armazenar segredos em variáveis de ambiente; emitir logs sem senhas/tokens/dados privados. **Evidência:** testes de regressão provaram que membro expulso não consegue apagar mensagem própria por ID nem voltar a entrar numa sala privada; sessão autorizada continua funcional.
- [x] Limitar mensagens a 2.000 caracteres, JSON de entrada a 16 KiB e rate limit API; tokens de convite/sessão têm armazenamento seguro. **Parcial para ficheiros:** não há upload; limites por ficheiro deverão ser implementados antes de aceitar ficheiros.

## 12. Arquitetura preparada para funções futuras

- [x] Não apresentar como feitas as funções avançadas que ainda não foram implementadas.
- [x] Documentar pontos de extensão para controlo individual do volume dos participantes; cancelamento de ruído/melhorias de áudio; canais de palco com oradores/ouvintes; fóruns/tópicos; upload de imagens, vídeos, GIFs e ficheiros; cargos personalizados; notificações push; ferramentas adicionais de moderação; integração de ferramenta de engenharia reversa, como REA, no ambiente de desenvolvimento.

## 13. Testes pedidos — resultados reais

- [x] Executar frontend e backend; executar migrações; testar registo e login; criar duas contas; criar comunidades e testar convite/saída; enviar mensagens entre sessões; verificar mensagem depois de reload completo; testar roles/admin/moderador/membro; testar desktop e telemóvel; testar ícone flutuante; corrigir erros observados.
- [ ] Testar entrada/saída e áudio de salas LiveKit em dispositivos diferentes, caso configurado. **Não executado.** Apenas token assinado foi exercitado; voz continua parcial.
- [x] Resultados atuais: `pnpm typecheck` passou; `pnpm test` passou (4/4); `pnpm build` passou; `MAVUNO_RUN_INTEGRATION_TESTS=1 pnpm test:integration` passou (50 verificações); Chromium passou 15 verificações no bundle de produção, incluindo reload, mensagem durante offline e reconexão sem duplicação, PWA offline com JS/CSS em cache e API excluída, ausência de violações CSP, layouts 390/1440 e botão flutuante; migração PostgreSQL aplicada. **Não declarar verificado:** build Docker (CLI indisponível), publicação externa nem áudio real.

## 14. Entrega e publicação

- [x] Código-fonte completo e organizado; `.env.example` sem credenciais; migrações; instruções de instalação/execução; configuração LiveKit; testes automatizados; lista de concluídas/parciais/pendentes; instruções de container/alojamento em `README.md`.
- [x] Implementar por etapas, executar código, testar fluxos principais e corrigir o erro reportado do preâmbulo Vite React. JSX agora é transformado pelo esbuild automático sem preâmbulo React-refresh inline; scripts continuam CSP `'self'` e o Preview pode enquadrar a aplicação.
- [ ] Deploy/abertura pública: Dockerfile está preparado, mas alojamento, HTTPS e publicação final ainda não foram executados nem confirmados. A primeira versão deve ser executável; considerar voz parcial até teste físico real.
