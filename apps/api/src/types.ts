import type { SseEventEnvelope } from '@journal/contracts';
import type { ContentSafeLogger } from '@journal/observability';
import type { Request } from 'express';
import type { AuthenticationService } from './auth.js';
import type { JournalService } from './journal-service.js';
import type { RecordingService } from './recording-service.js';
import type { ProcessorService } from './processor-service.js';
import type { TranscriptService } from './transcript-service.js';
import type { ArtifactService } from './artifact-service.js';
import type { ReprocessingService } from './reprocessing-service.js';

export interface AuthenticatedPrincipal {
  readonly ownerId: string;
}

export interface RequestAuthenticator {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | undefined>;
}

export interface HealthProbeResult {
  readonly status: 'healthy' | 'unhealthy' | 'not_configured';
  readonly detail?: string;
}

export interface HealthProbe {
  readonly name: string;
  readonly requiredForReadiness: boolean;
  check(): Promise<HealthProbeResult>;
}

export interface EventFeed {
  poll(
    ownerId: string,
    afterEventId: string | undefined,
  ): Promise<readonly SseEventEnvelope[]>;
  watch(
    ownerId: string,
    afterEventId: string | undefined,
    listener: (event: SseEventEnvelope) => void,
  ): Promise<() => void>;
}

export interface ApiDependencies {
  readonly artifactService?: ArtifactService;
  readonly authenticator: RequestAuthenticator;
  readonly authenticationService?: AuthenticationService;
  readonly eventFeed: EventFeed;
  readonly healthProbes: readonly HealthProbe[];
  readonly logger: ContentSafeLogger;
  readonly journalService?: JournalService;
  readonly recordingService?: RecordingService;
  readonly processorService?: ProcessorService;
  readonly reprocessingService?: ReprocessingService;
  readonly transcriptService?: TranscriptService;
  readonly now?: () => Date;
  readonly createCorrelationId?: () => string;
  readonly sseHeartbeatMilliseconds?: number;
}
