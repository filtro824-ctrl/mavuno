export type EmojiItem = { emoji: string; name: string };
export type EmojiCategoryId = 'recentes' | 'rostos' | 'gestos' | 'animais' | 'comida' | 'atividades' | 'objetos' | 'simbolos';
export type EmojiCategory = { id: EmojiCategoryId; label: string; items: EmojiItem[] };

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  { id: 'recentes', label: 'Recentes', items: [] },
  { id: 'rostos', label: 'Rostos', items: [
    { emoji: '😀', name: 'rosto sorridente' }, { emoji: '😃', name: 'rosto feliz' }, { emoji: '😄', name: 'sorriso aberto' }, { emoji: '😁', name: 'sorriso olhos fechados' },
    { emoji: '😆', name: 'a rir' }, { emoji: '😅', name: 'sorriso nervoso' }, { emoji: '😂', name: 'a chorar de rir' }, { emoji: '🤣', name: 'a rebolar de rir' },
    { emoji: '😊', name: 'sorriso tímido' }, { emoji: '😇', name: 'anjo' }, { emoji: '🙂', name: 'sorriso leve' }, { emoji: '🙃', name: 'rosto ao contrário' },
    { emoji: '😉', name: 'piscar o olho' }, { emoji: '🥰', name: 'rosto com corações' }, { emoji: '😍', name: 'olhos de coração' }, { emoji: '🤩', name: 'olhos brilhantes' },
    { emoji: '😘', name: 'beijo' }, { emoji: '😋', name: 'delicioso' }, { emoji: '😛', name: 'língua de fora' }, { emoji: '🤔', name: 'a pensar' },
    { emoji: '🤗', name: 'abraço' }, { emoji: '🤫', name: 'silêncio' }, { emoji: '🤭', name: 'mão sobre a boca' }, { emoji: '😐', name: 'neutro' },
    { emoji: '😶', name: 'sem palavras' }, { emoji: '🙄', name: 'revirar os olhos' }, { emoji: '😏', name: 'sorriso maroto' }, { emoji: '😴', name: 'a dormir' },
    { emoji: '😷', name: 'máscara' }, { emoji: '🤒', name: 'doente' }, { emoji: '🥳', name: 'festa' }, { emoji: '😎', name: 'óculos de sol' },
    { emoji: '😭', name: 'a chorar' }, { emoji: '😢', name: 'triste' }, { emoji: '😮', name: 'surpreso' }, { emoji: '😱', name: 'assustado' },
    { emoji: '😡', name: 'zangado' }, { emoji: '🤯', name: 'mente explodida' }, { emoji: '🥺', name: 'a pedir' }, { emoji: '🤤', name: 'a babar' },
  ] },
  { id: 'gestos', label: 'Gestos', items: [
    { emoji: '👋', name: 'aceno' }, { emoji: '🤚', name: 'mão levantada' }, { emoji: '🖐️', name: 'mão aberta' }, { emoji: '✋', name: 'mão parada' },
    { emoji: '👌', name: 'ok' }, { emoji: '🤌', name: 'dedos juntos' }, { emoji: '✌️', name: 'vitória' }, { emoji: '🤞', name: 'dedos cruzados' },
    { emoji: '🤟', name: 'amo-te' }, { emoji: '🤘', name: 'rock' }, { emoji: '🤙', name: 'liga-me' }, { emoji: '👈', name: 'apontar esquerda' },
    { emoji: '👉', name: 'apontar direita' }, { emoji: '👆', name: 'apontar cima' }, { emoji: '👇', name: 'apontar baixo' }, { emoji: '☝️', name: 'um dedo' },
    { emoji: '👍', name: 'gosto' }, { emoji: '👎', name: 'não gosto' }, { emoji: '✊', name: 'punho' }, { emoji: '👊', name: 'soco' },
    { emoji: '👏', name: 'palmas' }, { emoji: '🙌', name: 'mãos no ar' }, { emoji: '👐', name: 'mãos abertas' }, { emoji: '🤲', name: 'mãos juntas abertas' },
    { emoji: '🙏', name: 'obrigado oração' }, { emoji: '💪', name: 'força' }, { emoji: '🫶', name: 'mãos coração' }, { emoji: '🖕', name: 'dedo do meio' },
  ] },
  { id: 'animais', label: 'Animais', items: [
    { emoji: '🐶', name: 'cão' }, { emoji: '🐱', name: 'gato' }, { emoji: '🐭', name: 'rato' }, { emoji: '🐹', name: 'hamster' },
    { emoji: '🐰', name: 'coelho' }, { emoji: '🦊', name: 'raposa' }, { emoji: '🐻', name: 'urso' }, { emoji: '🐼', name: 'panda' },
    { emoji: '🐨', name: 'coala' }, { emoji: '🐯', name: 'tigre' }, { emoji: '🦁', name: 'leão' }, { emoji: '🐮', name: 'vaca' },
    { emoji: '🐷', name: 'porco' }, { emoji: '🐸', name: 'rã' }, { emoji: '🐵', name: 'macaco' }, { emoji: '🐔', name: 'galinha' },
    { emoji: '🐧', name: 'pinguim' }, { emoji: '🐦', name: 'pássaro' }, { emoji: '🦆', name: 'pato' }, { emoji: '🦅', name: 'águia' },
    { emoji: '🦉', name: 'coruja' }, { emoji: '🦇', name: 'morcego' }, { emoji: '🐺', name: 'lobo' }, { emoji: '🐗', name: 'javali' },
    { emoji: '🐴', name: 'cavalo' }, { emoji: '🦄', name: 'unicórnio' }, { emoji: '🐝', name: 'abelha' }, { emoji: '🦋', name: 'borboleta' },
    { emoji: '🐢', name: 'tartaruga' }, { emoji: '🐬', name: 'golfinho' }, { emoji: '🐳', name: 'baleia' }, { emoji: '🦓', name: 'zebra' },
  ] },
  { id: 'comida', label: 'Comida', items: [
    { emoji: '🍎', name: 'maçã' }, { emoji: '🍐', name: 'pera' }, { emoji: '🍊', name: 'laranja' }, { emoji: '🍋', name: 'limão' },
    { emoji: '🍌', name: 'banana' }, { emoji: '🍉', name: 'melancia' }, { emoji: '🍇', name: 'uvas' }, { emoji: '🍓', name: 'morango' },
    { emoji: '🫐', name: 'mirtilo' }, { emoji: '🥭', name: 'manga' }, { emoji: '🍍', name: 'ananás' }, { emoji: '🥥', name: 'coco' },
    { emoji: '🥑', name: 'abacate' }, { emoji: '🍆', name: 'beringela' }, { emoji: '🥕', name: 'cenoura' }, { emoji: '🌽', name: 'milho' },
    { emoji: '🌶️', name: 'pimento' }, { emoji: '🥒', name: 'pepino' }, { emoji: '🥬', name: 'folhas verdes' }, { emoji: '🍞', name: 'pão' },
    { emoji: '🧀', name: 'queijo' }, { emoji: '🥚', name: 'ovo' }, { emoji: '🍳', name: 'ovo frito' }, { emoji: '🍔', name: 'hambúrguer' },
    { emoji: '🍟', name: 'batatas fritas' }, { emoji: '🍕', name: 'pizza' }, { emoji: '🌭', name: 'cachorro quente' }, { emoji: '🍿', name: 'pipocas' },
    { emoji: '🍩', name: 'donut' }, { emoji: '🎂', name: 'bolo' }, { emoji: '☕', name: 'café' }, { emoji: '🧃', name: 'sumo' },
  ] },
  { id: 'atividades', label: 'Atividades', items: [
    { emoji: '⚽', name: 'futebol' }, { emoji: '🏀', name: 'basquetebol' }, { emoji: '🏈', name: 'futebol americano' }, { emoji: '⚾', name: 'basebol' },
    { emoji: '🎾', name: 'ténis' }, { emoji: '🏐', name: 'voleibol' }, { emoji: '🏉', name: 'rugby' }, { emoji: '🥏', name: 'disco' },
    { emoji: '🎱', name: 'bilhar' }, { emoji: '🏓', name: 'ténis de mesa' }, { emoji: '🏸', name: 'badminton' }, { emoji: '🥊', name: 'boxe' },
    { emoji: '🥋', name: 'artes marciais' }, { emoji: '⛳', name: 'golfe' }, { emoji: '⛷️', name: 'esqui' }, { emoji: '🏄', name: 'surf' },
    { emoji: '🏊', name: 'natação' }, { emoji: '🚴', name: 'ciclismo' }, { emoji: '🏆', name: 'troféu' }, { emoji: '🥇', name: 'medalha ouro' },
    { emoji: '🎯', name: 'alvo' }, { emoji: '🎮', name: 'videojogo' }, { emoji: '🎨', name: 'arte' }, { emoji: '🎭', name: 'teatro' },
    { emoji: '🎤', name: 'microfone' }, { emoji: '🎧', name: 'auscultadores' }, { emoji: '🎸', name: 'guitarra' }, { emoji: '🎹', name: 'piano' },
  ] },
  { id: 'objetos', label: 'Objetos', items: [
    { emoji: '⌚', name: 'relógio' }, { emoji: '📱', name: 'telemóvel' }, { emoji: '💻', name: 'computador' }, { emoji: '⌨️', name: 'teclado' },
    { emoji: '📷', name: 'câmara' }, { emoji: '💡', name: 'lâmpada' }, { emoji: '🔦', name: 'lanterna' }, { emoji: '📚', name: 'livros' },
    { emoji: '📌', name: 'alfinete' }, { emoji: '🔑', name: 'chave' }, { emoji: '🔒', name: 'cadeado' }, { emoji: '🧰', name: 'caixa ferramentas' },
    { emoji: '🎁', name: 'presente' }, { emoji: '🎈', name: 'balão' }, { emoji: '🧸', name: 'ursinho' }, { emoji: '🪄', name: 'varinha mágica' },
    { emoji: '🧭', name: 'bússola' }, { emoji: '🕯️', name: 'vela' }, { emoji: '🪴', name: 'planta' }, { emoji: '🧵', name: 'linha' },
    { emoji: '🪡', name: 'agulha' }, { emoji: '🧹', name: 'vassoura' }, { emoji: '🛠️', name: 'ferramentas' }, { emoji: '🪑', name: 'cadeira' },
  ] },
  { id: 'simbolos', label: 'Símbolos', items: [
    { emoji: '❤️', name: 'coração vermelho' }, { emoji: '🧡', name: 'coração laranja' }, { emoji: '💛', name: 'coração amarelo' }, { emoji: '💚', name: 'coração verde' },
    { emoji: '💙', name: 'coração azul' }, { emoji: '💜', name: 'coração roxo' }, { emoji: '🖤', name: 'coração preto' }, { emoji: '🤍', name: 'coração branco' },
    { emoji: '💔', name: 'coração partido' }, { emoji: '💕', name: 'dois corações' }, { emoji: '💯', name: 'cem pontos' }, { emoji: '💢', name: 'raiva' },
    { emoji: '💥', name: 'explosão' }, { emoji: '💫', name: 'tontura' }, { emoji: '💦', name: 'gotas' }, { emoji: '💤', name: 'sono' },
    { emoji: '✅', name: 'confirmação' }, { emoji: '❌', name: 'cruz' }, { emoji: '❓', name: 'interrogação' }, { emoji: '❗', name: 'exclamação' },
    { emoji: '⭐', name: 'estrela' }, { emoji: '🌟', name: 'estrela brilhante' }, { emoji: '🔥', name: 'fogo' }, { emoji: '✨', name: 'brilhos' },
    { emoji: '🌈', name: 'arco-íris' }, { emoji: '☀️', name: 'sol' }, { emoji: '🌙', name: 'lua' }, { emoji: '⚡', name: 'raio' },
    { emoji: '🎵', name: 'nota musical' }, { emoji: '♻️', name: 'reciclagem' }, { emoji: '⚠️', name: 'aviso' }, { emoji: '🔔', name: 'sino' },
  ] },
];

export const EMOJI_INDEX = new Map(EMOJI_CATEGORIES.flatMap((category) => category.items.map((item) => [item.emoji, item] as const)));
