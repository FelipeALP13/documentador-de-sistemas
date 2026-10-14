require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const BASE_ARTIFACTS = path.resolve('artifacts');
const MAX_CHAMADAS = Number(process.env.E2E_AI_MAX_CALLS || 15);
const MODELO = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: MODELO });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function encontrarExecucao() {
  const argumento = process.argv[2];

  if (argumento) {
    const dir = path.resolve(argumento);
    if (!fs.existsSync(dir)) {
      throw new Error(`Diretório não encontrado: ${dir}`);
    }
    return dir;
  }

  if (!fs.existsSync(BASE_ARTIFACTS)) {
    throw new Error('A pasta artifacts ainda não existe.');
  }

  const diretorios = fs
    .readdirSync(BASE_ARTIFACTS, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => ({
      nome: item.name,
      caminho: path.join(BASE_ARTIFACTS, item.name),
      mtime: fs.statSync(path.join(BASE_ARTIFACTS, item.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!diretorios.length) {
    throw new Error('Nenhuma execução encontrada dentro de artifacts.');
  }

  return diretorios[0].caminho;
}

function ehCotaDiaria(erro) {
  const mensagem = String(erro?.message || erro || '');

  return (
    mensagem.includes('GenerateRequestsPerDayPerProjectPerModel-FreeTier') ||
    mensagem.includes('generate_content_free_tier_requests') ||
    (mensagem.includes('429') && mensagem.toLowerCase().includes('quota'))
  );
}

function buscarScreenshot(dirScreenshots, nomeMetadata) {
  const base = path.basename(nomeMetadata, '.json');
  const candidatos = [
    path.join(dirScreenshots, `${base}.jpg`),
    path.join(dirScreenshots, `${base}.jpeg`),
    path.join(dirScreenshots, `${base}.png`),
  ];

  return candidatos.find(fs.existsSync) || null;
}

async function analisar(metadata, screenshotPath) {
  const imagem = fs.readFileSync(screenshotPath);

  const prompt = `Você é um Analista de Sistemas e Tech Writer Sênior.

Sua tarefa é documentar uma tela de um sistema web usando:
1. a screenshot anexada;
2. os metadados DOM abaixo.

A automação que coletou a evidência operou em SOMENTE LEITURA.
Não afirme que dados foram salvos, alterados, excluídos, enviados ou processados.

CONTEXTO:
${metadata.contexto}

METADADOS DOM:
${JSON.stringify(metadata, null, 2)}

Produza Markdown em Português do Brasil com:
- título claro;
- objetivo da tela;
- elementos presentes;
- campos e tabelas;
- filtros e pesquisas;
- abas;
- ações disponíveis;
- passo a passo de consulta/navegação;
- observações que precisem de validação funcional.

Não invente regras que não estejam visíveis na screenshot ou nos metadados.`;

  const result = await model.generateContent([
    prompt,
    {
      inlineData: {
        data: imagem.toString('base64'),
        mimeType: screenshotPath.toLowerCase().endsWith('.png')
          ? 'image/png'
          : 'image/jpeg',
      },
    },
  ]);

  return result.response.text();
}

(async () => {
  const dirRun = encontrarExecucao();
  const dirMetadata = path.join(dirRun, 'metadata');
  const dirScreenshots = path.join(dirRun, 'screenshots');

  if (!fs.existsSync(dirMetadata) || !fs.existsSync(dirScreenshots)) {
    throw new Error(`Execução inválida: ${dirRun}`);
  }

  console.log(`📂 Analisando execução: ${dirRun}`);
  console.log(`🤖 Modelo: ${MODELO}`);
  console.log(`🔢 Máximo de chamadas nesta execução: ${MAX_CHAMADAS}`);

  const arquivos = fs
    .readdirSync(dirMetadata)
    .filter(nome => nome.endsWith('.json'))
    .sort();

  const manual = [
    '# Manual Completo do Sistema\n\n',
    `> Gerado a partir das evidências de: ${path.basename(dirRun)}\n\n`,
    '---\n\n',
  ];

  const fingerprints = new Set();
  let chamadas = 0;
  let processados = 0;
  let duplicados = 0;

  for (const arquivo of arquivos) {
    const metadataPath = path.join(dirMetadata, arquivo);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    if (metadata.fingerprint && fingerprints.has(metadata.fingerprint)) {
      duplicados++;
      continue;
    }

    if (metadata.fingerprint) {
      fingerprints.add(metadata.fingerprint);
    }

    const screenshotPath = buscarScreenshot(dirScreenshots, arquivo);
    if (!screenshotPath) {
      console.log(`⚠️ Screenshot não encontrada para ${arquivo}`);
      continue;
    }

    if (chamadas >= MAX_CHAMADAS) {
      console.log(`⏹️ Limite interno de ${MAX_CHAMADAS} análises atingido.`);
      break;
    }

    console.log(`📸 ${metadata.contexto}`);
    chamadas++;

    try {
      const texto = await analisar(metadata, screenshotPath);
      manual.push(`<!-- ${path.basename(screenshotPath)} -->\n\n`);
      manual.push(texto);
      manual.push('\n\n---\n\n');
      processados++;
    } catch (erro) {
      console.log(`⚠️ Falha na análise: ${erro?.message || erro}`);

      if (ehCotaDiaria(erro)) {
        console.log('🛑 Cota do Gemini atingida. Encerrando a análise sem perder o progresso.');
        break;
      }

      await sleep(1500);
    }

    fs.writeFileSync(
      path.join(dirRun, 'manual-completo.md'),
      manual.join(''),
      'utf8'
    );
  }

  const destino = path.join(dirRun, 'manual-completo.md');
  fs.writeFileSync(destino, manual.join(''), 'utf8');

  console.log('');
  console.log('='.repeat(72));
  console.log('📊 RESUMO DA ANÁLISE');
  console.log(`Capturas analisadas....... ${processados}`);
  console.log(`Chamadas de IA............ ${chamadas}`);
  console.log(`Duplicados ignorados....... ${duplicados}`);
  console.log(`Manual.................... ${destino}`);
  console.log('='.repeat(72));
})().catch(erro => {
  console.error('❌ Erro:', erro);
  process.exitCode = 1;
});
