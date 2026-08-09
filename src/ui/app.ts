import type { RegistryRepository } from '../application/ports';
import type { Actor } from '../domain/models/global-registry';
import { renderAccessCreatePage } from './pages/access-create';
import { renderAccessDetailPage } from './pages/access-detail';
import { renderAccessListPage } from './pages/access-list';
import { renderDashboardPage } from './pages/dashboard';
import { renderDriftsPage } from './pages/drifts';
import { renderEventsPage } from './pages/events';
import { renderNotFoundPage } from './pages/not-found';
import { renderOperationDetailPage, renderOperationsPage } from './pages/operations';
import { renderPoliciesPage } from './pages/policies';
import { renderProfilesPage } from './pages/profiles';
import { renderProvidersPage } from './pages/providers';
import { renderResourceDetailPage } from './pages/resource-detail';
import { renderResourcesPage } from './pages/resources';
import type { UiPageContent } from './pages/types';
import { renderShell } from './shell';

type UiRepository = Pick<
  RegistryRepository,
  | 'getActor'
  | 'getOperationDetail'
  | 'getResourceDetail'
  | 'getResourceKindDefinition'
  | 'listActors'
  | 'listDrifts'
  | 'listEvents'
  | 'listOperations'
  | 'listPolicies'
  | 'listProfiles'
  | 'listProviders'
  | 'listResourceEvents'
  | 'listResources'
>;

interface RenderUiPageOptions {
  pathname: string;
  searchParams: URLSearchParams;
  actor: Actor;
  repository: UiRepository;
}

function normalizedPath(pathname: string): string {
  if (pathname === '/ui' || pathname === '/ui/') return '/ui';
  return pathname.replace(/\/+$/, '');
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function result(page: UiPageContent, actor: Actor, currentPath: string): string {
  return renderShell({
    actor,
    currentPath,
    title: page.title,
    body: page.body,
  });
}

async function pageForPath(options: RenderUiPageOptions): Promise<string | null> {
  const path = normalizedPath(options.pathname);
  const { actor, repository } = options;

  if (path === '/ui') {
    const [resources, operations, drifts, providers] = await Promise.all([
      repository.listResources({ limit: 100 }),
      repository.listOperations(),
      repository.listDrifts(),
      repository.listProviders(),
    ]);
    return result(renderDashboardPage({ resources, operations, drifts, providers }), actor, path);
  }

  if (path === '/ui/resources') {
    const limit = 100;
    const cursor = options.searchParams.get('cursor') ?? undefined;
    const resources = await repository.listResources({
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const nextCursor = resources.length === limit ? (resources.at(-1)?.key ?? null) : null;
    return result(renderResourcesPage(resources, nextCursor), actor, path);
  }

  const resourceMatch = /^\/ui\/resources\/([^/]+)$/.exec(path);
  if (resourceMatch !== null) {
    const encodedKey = resourceMatch[1];
    const key = encodedKey === undefined ? null : decodePathSegment(encodedKey);
    if (key !== null) {
      const relationshipCursor = options.searchParams.get('relationshipCursor') ?? undefined;
      const driftCursor = options.searchParams.get('driftCursor') ?? undefined;
      const detail = await repository.getResourceDetail(key, {
        relationshipLimit: 50,
        driftLimit: 50,
        ...(relationshipCursor === undefined ? {} : { relationshipCursor }),
        ...(driftCursor === undefined ? {} : { driftCursor }),
      });
      if (detail !== null) {
        const [allResources, events, definition] = await Promise.all([
          repository.listResources({ limit: 100 }),
          repository.listResourceEvents(key),
          repository.getResourceKindDefinition(detail.resource.kind, detail.resource.kindVersion),
        ]);
        if (definition === null) return null;
        return result(
          renderResourceDetailPage({
            detail,
            allResources,
            events,
            actor,
            definition,
            query: {
              ...(relationshipCursor === undefined ? {} : { relationshipCursor }),
              ...(driftCursor === undefined ? {} : { driftCursor }),
            },
          }),
          actor,
          path,
        );
      }
    }
    return null;
  }

  if (path === '/ui/providers') {
    return result(renderProvidersPage(await repository.listProviders()), actor, path);
  }

  if (path === '/ui/operations') {
    return result(renderOperationsPage(await repository.listOperations()), actor, path);
  }

  const operationMatch = /^\/ui\/operations\/([^/]+)$/.exec(path);
  if (operationMatch !== null) {
    const encodedId = operationMatch[1];
    const id = encodedId === undefined ? null : decodePathSegment(encodedId);
    if (id !== null) {
      const detail = await repository.getOperationDetail(id);
      if (detail !== null) return result(renderOperationDetailPage(detail), actor, path);
    }
    return null;
  }

  if (path === '/ui/drifts') {
    return result(renderDriftsPage(await repository.listDrifts()), actor, path);
  }

  if (path === '/ui/profiles') {
    return result(renderProfilesPage(await repository.listProfiles()), actor, path);
  }

  if (path === '/ui/policies') {
    return result(renderPoliciesPage(await repository.listPolicies()), actor, path);
  }

  if (path === '/ui/events') {
    return result(renderEventsPage(await repository.listEvents(100)), actor, path);
  }

  if (path === '/ui/access' || path === '/ui/access/new' || path.startsWith('/ui/access/')) {
    if (actor.role !== 'admin') return null;

    if (path === '/ui/access') {
      return result(
        renderAccessListPage({
          actors: await repository.listActors(),
          searchParams: options.searchParams,
        }),
        actor,
        path,
      );
    }

    if (path === '/ui/access/new') {
      return result(renderAccessCreatePage(), actor, path);
    }

    const actorMatch = /^\/ui\/access\/([^/]+)$/.exec(path);
    if (actorMatch !== null) {
      const encodedId = actorMatch[1];
      const id = encodedId === undefined ? null : decodePathSegment(encodedId);
      if (id !== null) {
        const targetActor = await repository.getActor(id);
        if (targetActor !== null) {
          return result(
            renderAccessDetailPage({ actor: targetActor, currentActor: actor }),
            actor,
            path,
          );
        }
      }
      return null;
    }
  }

  if (path === '/ui/not-found') return result(renderNotFoundPage(), actor, path);
  return null;
}

export async function renderUiPage(options: RenderUiPageOptions): Promise<string | null> {
  if (!options.pathname.startsWith('/ui')) return null;
  return pageForPath(options);
}
