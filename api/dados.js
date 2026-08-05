import { Redis } from "@upstash/redis";

/* Aceita as variáveis criadas pelo marketplace (Upstash) ou pelo Vercel KV */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const CHAVE = "agua:dados";
const CHAVE_BACKUP = "agua:backup";
const VAZIO = { members: [], intake: {} };

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
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
      }

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
