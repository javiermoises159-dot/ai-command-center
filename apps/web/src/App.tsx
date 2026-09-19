import { Layout } from './components/Layout.tsx';
import { EmptyState } from './components/primitives.tsx';
import { useRouter } from './lib/router.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { MissionPage } from './pages/MissionPage.tsx';
import { MissionsPage } from './pages/MissionsPage.tsx';

export function App() {
  const { route } = useRouter();

  return (
    <Layout>
      {route.name === 'dashboard' && <DashboardPage />}
      {route.name === 'missions' && <MissionsPage />}
      {route.name === 'mission' && <MissionPage key={route.id} id={route.id} />}
      {route.name === 'not-found' && (
        <EmptyState title="Nothing here" body={`No screen matches ${route.path}.`} />
      )}
    </Layout>
  );
}
