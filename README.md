# Documentador de Sistemas

Aplicativo pessoal para mapear sistemas web e gerar documentação a partir das telas capturadas. Informe a URL, o usuário ou e-mail e a senha. A automação identifica formulários de acesso, menus, submenus, frames, links internos, abas e telas de criação.

## Modo somente leitura

A varredura abre telas e formulários **Novo/Nova, Adicionar, Cadastrar e Incluir**, mas não preenche campos nem aciona controles de salvar, excluir, enviar, publicar, aprovar, pagar ou confirmar. Depois do login, qualquer requisição com método de escrita é bloqueada. Endereços `GET` que indicam ações destrutivas também são bloqueados, e service workers ficam desativados durante a varredura para que não contornem essa proteção.

## Compatibilidade

- login com usuário ou e-mail e senha na mesma página;
- login em duas etapas, com usuário/e-mail antes da senha;
- interfaces modernas, aplicações de página única e sistemas JSP legados;
- frames e iframes aninhados;
- menus por clique ou hover;
- abas ARIA, Bootstrap e JSP;
- links internos seguros e formulários de criação;
- diagnóstico de URL, título, frames, seletores e falhas HTTP sem valores de credenciais.
- reautenticação automática quando a sessão expira durante varreduras longas;
- erros JavaScript e respostas HTTP do sistema registrados como avisos, sem interromper os demais menus.

CAPTCHA, MFA, páginas sem permissão e respostas HTTP de erro exigem intervenção ou correção no sistema de origem. O aplicativo registra esses casos e continua quando for seguro.

## Executar

```powershell
npm install
npm test
npm run desktop:start
```

Para gerar o portátil:

```powershell
npm run desktop:build
```

O arquivo é criado em `dist/Documentador-de-Sistemas-<versão>-portable.exe`.

O botão **Conferir imagens** valida localmente o formato e o limite de 6 MB de cada captura da execução mais recente. Ele não chama o Gemini nem escreve o manual. Depois da conferência, informe o endereço do proxy e o código de acesso e use **Gerar ou retomar manual**.

## Proxy Gemini

A chave Gemini permanece somente no serviço proxy e nunca é incorporada ao executável. Consulte [proxy/README.md](proxy/README.md) para configurar o serviço e fornecer ao aplicativo apenas o endereço HTTPS e um código de acesso.

## Privacidade

`.env`, capturas, diagnósticos, estado de sessão, dependências e executáveis são excluídos do histórico Git. As credenciais informadas na interface são mantidas somente durante a operação e removidas dos diagnósticos.
