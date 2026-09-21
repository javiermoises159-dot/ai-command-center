import { Layout } from './components/Layout.tsx';
import { EmptyState, LinkButton } from './components/primitives.tsx';
import { t } from './i18n/index.ts';
import { href, useRouter } from './lib/router.tsx';
import { ActivityPage } from './pages/ActivityPage.tsx';
import { AgentsPage } from './pages/AgentsPage.tsx';
import { ContentPage } from './pages/ContentPage.tsx';
import { CreativePage } from './pages/CreativePage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { KnowledgePage } from './pages/KnowledgePage.tsx';
import { MissionPage } from './pages/MissionPage.tsx';
import { MissionsPage } from './pages/MissionsPage.tsx';
import { ResearchPage } from './pages/ResearchPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { ToolsPage } from './pages/ToolsPage.tsx';

export function App() {
  const { route } = useRouter();

  return (
    <Layout>
      {route.name === 'dashboard' && <DashboardPage />}
      {route.name === 'missions' && <MissionsPage />}
      {route.name === 'mission' && <MissionPage key={route.id} id={route.id} />}
      {route.name === 'agents' && <AgentsPage />}
      {route.name === 'knowledge' && <KnowledgePage />}
      {route.name === 'research' && <ResearchPage />}
      {route.name === 'tools' && <ToolsPage />}
      {route.name === 'creative' && <CreativePage />}
      {route.name === 'content' && <ContentPage />}
      {route.name === 'activity' && <ActivityPage />}
      {route.name === 'settings' && <SettingsPage />}
      {route.name === 'not-found' && (
        <EmptyState
          icon="compass"
          title={t.layout.notFound.title}
          body={t.layout.notFound.body(route.path)}
          action={<LinkButton href={href({ name: 'dashboard' })}>{t.layout.notFound.action}</LinkButton>}
        />
      )}
    </Layout>
  );
}
