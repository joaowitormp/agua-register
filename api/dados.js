import { Redis } from "@upstash/redis";

/* Aceita as variáveis criadas pelo marketplace (Upstash) ou pelo Vercel KV */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const CHAVE = "agua:dados";
const CHAVE_BACKUP = "agua:backup";
const VAZIO = { members: [], intake: {} };
/* Carimbo do código da API em execução — conferível em /api/dados?versao=1 */
const API_VERSION = "2026-08-29.1-agua-protegida";

/* Fusão do histórico: em vez de aceitar a sobrescrita cega do documento,
   o servidor une as entradas já salvas com as recebidas (chave = momento
   + tipo). Uma aba desatualizada não consegue mais apagar registros que
   outras pessoas fizeram. Entradas anuladas (Desfazer) prevalecem */
const mesclarHistorico = (antigo, novo) => {
  const resultado = {};
  const ids = new Set([
    ...Object.keys(antigo || {}),
    ...Object.keys(novo || {}),
  ]);
  ids.forEach((id) => {
    const mapa = new Map();
    [
      ...((antigo && antigo[id]) || []),
      ...((novo && novo[id]) || []),
    ].forEach((e) => {
      if (!e || typeof e.t !== "number") return;
      const chave = `${e.t}-${e.tipo || ""}`;
      const existente = mapa.get(chave);
      if (!existente || e.anulado) mapa.set(chave, { ...existente, ...e });
    });
    resultado[id] = [...mapa.values()].sort((a, b) => a.t - b.t).slice(-100);
  });
  return resultado;
};

/* O "último registro de água" de cada pessoa só anda para frente */
const mesclarUltimo = (antigo, novo) => {
  const resultado = { ...(antigo || {}) };
  Object.keys(novo || {}).forEach((id) => {
    resultado[id] = Math.max(
      Number(resultado[id] || 0),
      Number(novo[id] || 0)
    );
  });
  return resultado;
};

/* Metas congeladas por dia: uma vez gravada, a meta daquele dia nunca é
   sobrescrita por uma aba desatualizada — é o que impede alterar a meta
   hoje e "reescrever" se os dias antigos foram batidos ou não */
const mesclarMetas = (antigo, novo) => {
  const resultado = { ...(antigo || {}) };
  Object.keys(novo || {}).forEach((dia) => {
    resultado[dia] = { ...(novo[dia] || {}), ...(resultado[dia] || {}) };
  });
  return resultado;
};

/* Intake e extras: a água registrada nunca regride. Se duas abas gravam
   quase juntas, a atrasada traz um total menor de alguém — aceitar isso
   apagaria o que a outra acabou de registrar. Então, por (dia, membro),
   vence o MAIOR valor. Só um Desfazer explícito reduz, e ele é raro e
   local; o risco de perder registro é muito pior que o de um desfazer
   demorar um ciclo a aparecer para terceiros */
const mesclarContagem = (antigo, novo, reduzir) => {
  const resultado = {};
  const dias = new Set([
    ...Object.keys(antigo || {}),
    ...Object.keys(novo || {}),
  ]);
  dias.forEach((dia) => {
    const a = (antigo && antigo[dia]) || {};
    const n = (novo && novo[dia]) || {};
    const ids = new Set([...Object.keys(a), ...Object.keys(n)]);
    const linha = {};
    ids.forEach((id) => {
      const autorizouReduzir = !!(reduzir && reduzir[dia] && reduzir[dia][id]);
      /* Desfazer explícito: aceita o valor que o cliente mandou (pode ser
         menor). Fora isso, vence o maior — água não regride sozinha */
      linha[id] = autorizouReduzir
        ? Number(n[id] || 0)
        : Math.max(Number(a[id] || 0), Number(n[id] || 0));
    });
    resultado[dia] = linha;
  });
  return resultado;
};

/* Histórico independente da versão do app: se a gravação recebida
   aumenta as garrafas/avulsos de alguém sem trazer a entrada
   correspondente (o caso de abas rodando código antigo), o próprio
   servidor cria a entrada que falta — sem duplicar as que já vieram */
const completarHistorico = (atual, corpo) => {
  const agora = Date.now();
  (corpo.members || []).forEach((m) => {
    const id = m.id;
    let deltaG = 0;
    Object.keys(corpo.intake || {}).forEach((d) => {
      const nova = Number((corpo.intake[d] || {})[id] || 0);
      const velha = Number((((atual && atual.intake) || {})[d] || {})[id] || 0);
      if (nova > velha) deltaG += nova - velha;
    });
    let deltaMl = 0;
    Object.keys(corpo.extras || {}).forEach((d) => {
      const nova = Number((corpo.extras[d] || {})[id] || 0);
      const velha = Number((((atual && atual.extras) || {})[d] || {})[id] || 0);
      if (nova > velha) deltaMl += nova - velha;
    });
    if (deltaG <= 0 && deltaMl <= 0) return;

    /* Desconta o que o próprio cliente já registrou nesta gravação */
    const jaSalvas = new Set(
      (((atual && atual.historico) || {})[id] || []).map(
        (e) => `${e.t}-${e.tipo || ""}`
      )
    );
    let trouxeG = 0;
    let trouxeMl = 0;
    (((corpo.historico || {})[id]) || []).forEach((e) => {
      if (!e || jaSalvas.has(`${e.t}-${e.tipo || ""}`)) return;
      if (e.tipo === "g") trouxeG += 1;
      else if (e.tipo === "e") trouxeMl += Number(e.ml || 0);
    });

    const faltamG = deltaG - trouxeG;
    const faltamMl = deltaMl - trouxeMl;
    if (faltamG <= 0 && faltamMl <= 0) return;
    if (!corpo.historico) corpo.historico = {};
    if (!Array.isArray(corpo.historico[id])) corpo.historico[id] = [];
    for (let i = 0; i < faltamG; i++) {
      corpo.historico[id].push({
        t: agora + i,
        tipo: "g",
        ml: Number(m.bottleMl || 0),
      });
    }
    if (faltamMl > 0) {
      corpo.historico[id].push({ t: agora + 500, tipo: "e", ml: faltamMl });
    }
  });
};

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      if (req.query && req.query.versao) {
        return res.status(200).json({ apiVersion: API_VERSION });
      }
      const chave = req.query && req.query.backup ? CHAVE_BACKUP : CHAVE;
      const dados = await redis.get(chave);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(dados || VAZIO);
    }

    if (req.method === "POST") {
      const corpo =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!corpo || !Array.isArray(corpo.members) || typeof corpo.intake !== "object") {
        return res.status(400).json({ error: "Estrutura de dados inválida" });
      }

      /* Trava anti-apagão: bloqueia gravação que zeraria os membros
         quando já existem 2 ou mais salvos; e backup antes de sobrescrever */
      const atual = await redis.get(CHAVE);
      if (atual && Array.isArray(atual.members)) {
        if (atual.members.length >= 2 && corpo.members.length === 0) {
          return res
            .status(409)
            .json({ error: "Gravação bloqueada: apagaria todos os membros" });
        }
        await redis.set(CHAVE_BACKUP, atual);
        completarHistorico(atual, corpo);
        corpo.intake = mesclarContagem(atual.intake, corpo.intake, corpo.reduzir);
        corpo.extras = mesclarContagem(atual.extras, corpo.extras, corpo.reduzir);
        corpo.historico = mesclarHistorico(atual.historico, corpo.historico);
        corpo.ultimo = mesclarUltimo(atual.ultimo, corpo.ultimo);
        corpo.metas = mesclarMetas(atual.metas, corpo.metas);
      }

      delete corpo.reduzir; /* campo auxiliar de gravação, não persiste */
      await redis.set(CHAVE, corpo);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Método não permitido" });
  } catch (erro) {
    return res
      .status(500)
      .json({ error: (erro && erro.message) || String(erro) });
  }
}
