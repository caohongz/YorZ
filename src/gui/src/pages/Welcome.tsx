import { createSignal, type Component } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { Plus } from 'lucide-solid'
import { AddProjectDialog } from '../components/AddProjectDialog.js'
import { Button } from '../components/ui/button.jsx'
import { projectHref } from '../lib/project.js'
import { t } from '../i18n/index.js'

export const WelcomePage: Component = () => {
  const navigate = useNavigate()
  const [addOpen, setAddOpen] = createSignal(false)

  return (
    <section class="p-8">
      <header class="mb-4">
        <h1 class="text-2xl font-bold">{t('welcome.title')}</h1>
      </header>
      <p class="text-muted-foreground">{t('welcome.description')}</p>
      <Button class="mt-4 gap-1" onClick={() => setAddOpen(true)}>
        <Plus class="h-4 w-4" />
        {t('addProject.trigger')}
      </Button>

      <AddProjectDialog
        open={addOpen()}
        onOpenChange={setAddOpen}
        onAdded={(projectId) => navigate(projectHref('', projectId))}
      />
    </section>
  )
}
