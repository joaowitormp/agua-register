import { put, get } from "@vercel/blob";

const CAMINHO = "agua/dados.json";
const VAZIO = { members: [], intake: {} };

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const resultado = await get(CAMINHO, {
        access: "private",
        useCache: false,
      });
      res.setHeader("Cache-Control", "no-store");
      if (!resultado || resultado.statusCode !== 200 || !resultado.stream) {
        // Primeiro acesso: ainda não existe arquivo salvo
        return res.status(200).json(VAZIO);
      }
      const texto = await new Response(resultado.stream).text();
      return res.status(200).send(texto);
    }

    if (req.method === "POST") {
      const corpo =
        typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      // Validação mínima: precisa ser JSON com a estrutura esperada
      const dados = JSON.parse(corpo);
      if (!Array.isArray(dados.members) || typeof dados.intake !== "object") {
        return res.status(400).json({ error: "Estrutura de dados inválida" });
      }
      await put(CAMINHO, corpo, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
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
