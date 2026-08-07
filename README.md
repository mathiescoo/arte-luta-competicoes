# Arte-Luta Brasil Competições

Plataforma responsiva para organizar campeonatos, festivais e competições da Capoeira Arte-Luta Brasil. A base inclui painel operacional, eventos configuráveis, três rodas independentes, musicalidade por somatório, bandeiras digitais, resultados, PWA e banco Supabase protegido por RLS.

## Executar

1. Instale Node.js 20 ou superior.
2. Copie `.env.example` para `.env.local` e informe as chaves públicas do Supabase.
3. Execute `npm install` e `npm run dev`.
4. Valide com `npm test`, `npm run lint` e `npm run build`.

## Configurar o Supabase

1. Crie um projeto gratuito e abra **SQL Editor**.
2. Execute `supabase/migrations/001_initial.sql`.
3. Em Authentication, habilite e-mail/senha e desative cadastro público se apenas administradores puderem convidar usuários.
4. Copie URL e chave `anon` para `.env.local`. A `service role` nunca deve usar prefixo `NEXT_PUBLIC_` nem ir ao navegador.
5. Crie o primeiro usuário em Authentication > Users. Depois insira `profiles`, `organizations` e `user_roles` com papel `admin` pelo SQL Editor.

Exemplo para o primeiro administrador (substitua os UUIDs):

```sql
insert into public.organizations (id,name,slug) values ('UUID-ORG','Capoeira Arte-Luta Brasil','arte-luta-brasil');
insert into public.profiles (id,full_name) values ('UUID-AUTH','Administrador');
insert into public.user_roles (user_id,organization_id,role) values ('UUID-AUTH','UUID-ORG','admin');
```

Organizadores, juízes e telões são usuários do Supabase Auth associados em `event_users`; designações específicas de juízes ficam em `judge_assignments`. Nunca reutilize contas entre juízes.

## Modelo de dados e segurança

A migration cria organizações, perfis, papéis, eventos, competições, categorias, inscrições, participantes, rodas, designações, apresentações, critérios, avaliações, confrontos, votos, regulamentos versionados, resultados, pódios e auditoria. Restrições únicas impedem avaliação e voto duplicados. Notas aceitam somente 0–10. As políticas RLS isolam eventos, tarefas de juiz e resultados publicados; votos são aceitos apenas na roda/categoria designada e no confronto atual. Canais Realtime foram ativados nas entidades operacionais.

## Regras implementadas e testadas

- Musicalidade soma todas as notas de todos os juízes, sem média, e só produz total após todos enviarem.
- Bandeiras exigem três votos e apuram 3×0 ou 2×1.
- O modo mistério oculta o ranking nos três participantes finais.
- Votos e avaliações possuem unicidade por confronto/apresentação e juiz.

## Publicar na Vercel

1. Envie o repositório ao GitHub e importe-o na Vercel.
2. Cadastre `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` nas variáveis do projeto.
3. Mantenha a região próxima de São Paulo quando disponível e publique. O comando padrão é `npm run build`.
4. No Supabase Auth, inclua a URL final da Vercel em Site URL e Redirect URLs.

## Instalar no celular

Abra a URL publicada. No Android/Chrome use **Instalar app**; no iPhone/Safari use **Compartilhar > Adicionar à Tela de Início**. O service worker mantém a interface básica acessível, mas votos, avaliações e atualizações ao vivo dependem de conexão confirmada pelo servidor.

## Fluxo de operação

Crie um evento pelo assistente, escolha o modelo, cadastre categorias e participantes, crie as rodas e vincule cada juiz à competição, categoria e roda. Abra cada telão em uma sessão somente leitura. Antes de publicar resultados, confira pendências, resolva empates com justificativa e registre a homologação.

Os dados exibidos no painel inicial são demonstração visual segura e não contêm informações pessoais reais. Após conectar o Supabase, substitua a coleção de demonstração pelas consultas protegidas das tabelas correspondentes.
