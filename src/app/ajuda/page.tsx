import Link from "next/link";
import { BookOpen, CalendarDays, Gavel, MonitorPlay, Users, Music2, FileDown } from "lucide-react";

const guides = [
  { icon: CalendarDays, title: "1. Preparar o evento", text: "Em Eventos, selecione as competições e suas categorias. Nas configurações do evento, defina o status e se o pagamento será exigido. O pagamento é opcional para cada evento.", href: "/eventos" },
  { icon: Users, title: "2. Receber inscrições", text: "Na página do evento, configure os campos do formulário, ative o link e salve. Para receber respostas, coloque o evento em Inscrições abertas. O link mostra as músicas escolhidas e bloqueia repetição nas inscrições de musicalidade.", href: "/eventos" },
  { icon: Users, title: "3. Credenciar participantes", text: "Confira nome, idade e categoria. No credenciamento, selecione o evento e registre a presença. Só confirme pagamento se ele for exigido pela organização.", href: "/credenciamento" },
  { icon: Gavel, title: "4. Liberar e designar juízes", text: "O administrador aprova as solicitações em Liberação de juízes. Depois, em Eventos → Juízes e rodas, designe os aprovados às categorias. Aprovar o acesso e designar ao evento são etapas diferentes.", href: "/juizes" },
  { icon: Music2, title: "5. Cante Comigo", text: "Configure os critérios e designe pelo menos um juiz ativo por categoria. Gere e sorteie a fila; abra a apresentação para chamar o participante no telão. Inicie o cronômetro somente quando ele começar a cantar. A nota final é a média normalizada de 0 a 10.", href: "/pontuacao" },
  { icon: Gavel, title: "6. Campeonato e Festival Mirim", text: "Prepare as rodas, confronte os participantes e designe os juízes. A votação usa bandeiras azul e verde; confira os votos antes de confirmar o resultado. Este fluxo é diferente das apresentações de musicalidade.", href: "/rodas" },
  { icon: MonitorPlay, title: "7. Telão e resultados", text: "Escolha o evento e a modalidade correta ao criar o telão. Para musicalidade, não é necessário criar rodas. Abra o link no monitor e use F11 no computador para ocupar a tela. Confira e publique os resultados por categoria.", href: "/telao" },
  { icon: FileDown, title: "8. Encerrar e guardar o PDF", text: "Conclua ou resolva todas as apresentações e confrontos pendentes. Na página do evento, use Finalizar evento e gerar PDF. O encerramento é definitivo; o relatório fica disponível para baixar novamente.", href: "/eventos" },
];

export default function HelpPage() {
  return <main className="management-page"><Link className="back-link" href="/painel">← Voltar para visão geral</Link>
    <div className="management-top"><div><span className="eyebrow">SUPORTE OPERACIONAL</span><h1>Central de ajuda</h1><p>Do cadastro ao relatório final: escolha o fluxo de cada modalidade.</p></div></div>
    <section className="help-grid">{guides.map((guide) => { const Icon = guide.icon; return <Link href={guide.href} key={guide.title}><Icon /><span>GUIA</span><h2>{guide.title}</h2><p>{guide.text}</p><b>Abrir módulo →</b></Link>; })}</section>
    <section className="help-note"><BookOpen /><div><strong>Antes de começar</strong><ul className="help-checklist">
      <li>Teste a internet no computador da organização, nos celulares dos juízes e no telão.</li>
      <li>Confira o evento selecionado, as categorias, os participantes credenciados e os juízes designados.</li>
      <li>Faça um ensaio separado dos dados oficiais: chamada, início e pausa do tempo, envio das notas e atualização do telão.</li>
      <li>Se a conexão cair, não repita uma inscrição ou nota sem conferir se ela já foi salva.</li>
      <li>Depois de encerrar, baixe e confira o PDF antes de sair.</li>
    </ul><p>O aplicativo depende de internet para salvar dados e atualizar os outros dispositivos; ele não possui modo de operação offline.</p></div></section>
  </main>;
}
