import type { WorkerCommand } from '../../shared/protocol/requests';
import type { WorkerResult } from '../../shared/protocol/responses';
import type { LibraryService } from '../library-service';

export async function executeAnimationAssetCommand(service: LibraryService, command: WorkerCommand): Promise<WorkerResult | undefined> {
  switch (command.type) {
    case 'animation.get': return { ok: true, type: 'animation.got', animation: service.animationRepository(command.libraryId).info(command.assetId) };
    case 'animation.read': return { ok: true, type: 'animation.read', ...service.animationRepository(command.libraryId).read(command) };
    case 'animation.import': return { ok: true, type: 'animation.imported', animation: await service.animationRepository(command.libraryId, true).importBundle(command) };
    case 'animation.preview.stage': return { ok: true, type: 'animation.preview.staged', ...service.animationRepository(command.libraryId, true).stage(command) };
    case 'animation.preview.publish': return { ok: true, type: 'animation.preview.published', animation: await service.animationRepository(command.libraryId, true).publish(command) };
    case 'animation.preview.cancel': return { ok: true, type: 'animation.preview.cancelled', ...service.animationRepository(command.libraryId, true).cancel(command) };
    default: return undefined;
  }
}
