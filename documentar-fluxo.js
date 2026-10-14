// Entrada legada: usa o mesmo crawler mantido pelo aplicativo e por npm run scan.
const { main } = require('./varredura-completa');
main().catch(error => { console.error('Falha:', error.message); process.exitCode = 1; });
