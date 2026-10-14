require('dotenv').config();
const { chromium } = require('playwright');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

// Conectando com o cérebro (Gemini) usando a sua chave
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

(async () => {
  console.log('1. Abrindo navegador já logado (usando o crachá salvo)...');
  const browser = await chromium.launch({ headless: false });
  // Aqui dizemos para ele usar o login que acabamos de salvar
  const context = await browser.newContext({ storageState: 'estado-sessao.json' });
  const page = await context.newPage();

  console.log('2. Navegando até a tela que será documentada...');
  if (!process.env.SISTEMA_URL) throw new Error('Defina SISTEMA_URL no arquivo .env local.');
  await page.goto(process.env.SISTEMA_URL);
  
  // Espera a página terminar de carregar todas as informações
  await page.waitForLoadState('networkidle');

  console.log('3. Tirando a foto da tela...');
  
  // Dá um respiro de 2 segundos (2000 milissegundos) para a tela estabilizar
  await page.waitForTimeout(2000); 
  
  // Tira a foto apenas do que está visível, o que resolve o erro do Playwright
  const screenshotBuffer = await page.screenshot(); 
  const base64Image = screenshotBuffer.toString('base64');

  console.log('4. Enviando a imagem para a IA analisar e escrever o manual...');
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  
  const prompt = `Você é um Analista de Sistemas e Tech Writer Sênior. 
  Analise este screenshot de uma tela de sistema e crie uma documentação técnica em Markdown.
  Sua resposta deve conter:
  - **Objetivo da tela:** Para que serve essa página?
  - **Elementos Principais:** Liste os campos, tabelas ou botões visíveis que o usuário precisa interagir.
  - **Ações:** O que se espera que o usuário faça aqui?
  Seja direto, profissional e focado na usabilidade do usuário final.`;

  const result = await model.generateContent([
    prompt,
    { inlineData: { data: base64Image, mimeType: 'image/png' } }
  ]);

  const textoDocumentacao = result.response.text();

  console.log('5. Salvando o arquivo de texto...');
  // Cria um arquivo .md com o nome "manual-da-tela.md"
  fs.writeFileSync('manual-da-tela.md', textoDocumentacao);

  console.log('Finalizado com sucesso! Pode fechar.');
  await browser.close();
})();
