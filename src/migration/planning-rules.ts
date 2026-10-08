import type { MigrationCategory } from './comparison-model.js';
import type {
  MigrationDecision,
  MigrationPhaseId,
  MigrationStep,
  ValidationCheck,
} from './migration-plan.js';

interface PlanningRule {
  codes: string[];
  category: MigrationCategory;
  phase: MigrationPhaseId;
  step: Omit<
    MigrationStep,
    'reason' | 'affectedObjects' | 'automated' | 'requiresConfirmation'
  >;
  decision?: Omit<MigrationDecision, 'reason' | 'affectedObjects'>;
  checks: ValidationCheck[];
}

export const registrationChecks: ValidationCheck[] = [
  {
    id: 'validate-content-registrations',
    title: 'Validate content type registrations',
    description:
      'Verify approved source content types and reconciled settings are available on the target.',
    category: 'content',
  },
  {
    id: 'validate-taxonomy-registrations',
    title: 'Validate taxonomy registrations',
    description:
      'Verify approved taxonomies, settings, and associated post types on the target.',
    category: 'taxonomy',
  },
];
export const userMappingCheck: ValidationCheck = {
  id: 'validate-user-mapping',
  title: 'Validate user identity handling',
  description:
    'Verify every in-scope source user has an approved target identity and that authorship, roles, and memberships follow the chosen strategy.',
  category: 'users',
};
export const mediaFilesCheck: ValidationCheck = {
  id: 'validate-media-availability',
  title: 'Validate media availability',
  description:
    'Check required local or external media availability according to the approved storage policy; offloaded files need not exist locally.',
  category: 'media',
};
export const sourceReferencesCheck: ValidationCheck = {
  id: 'validate-source-references',
  title: 'Validate source-environment references',
  description:
    'Verify no unintended source-host or filesystem references remain within the approved scope; retain intentional references and preserve serialized/JSON integrity.',
  category: 'urls',
};

// Explicit mappings only. Risk describes the proposed preparation work, rather
// than copying the comparison severity (which is retained in plan issues).
export const planningRules: readonly PlanningRule[] = [
  {
    codes: ['MULTISITE_MODE_MISMATCH'],
    category: 'environment',
    phase: 'environment-preparation',
    step: {
      id: 'resolve-multisite-strategy',
      title: 'Confirm multisite migration strategy',
      description:
        'Define the site/network topology and ownership boundaries before any direct migration is considered.',
      category: 'environment',
      risk: 'high',
    },
    decision: {
      id: 'choose-multisite-migration-strategy',
      question:
        'How should source sites and network data map into the target topology?',
      options: [
        'align-installation-modes',
        'design-explicit-topology-conversion',
        'defer-migration',
      ],
    },
    checks: [
      {
        id: 'validate-site-topology',
        title: 'Validate site topology',
        description:
          'Verify site/network boundaries and URLs against the explicitly approved topology.',
        category: 'environment',
      },
    ],
  },
  {
    codes: ['VERSION_DIFFERENCE'],
    category: 'environment',
    phase: 'environment-preparation',
    step: {
      id: 'review-runtime-compatibility',
      title: 'Review runtime compatibility',
      description:
        'Review WordPress, CLI PHP, and extension compatibility before choosing target runtime versions. Version differences do not prove incompatibility.',
      category: 'environment',
      risk: 'medium',
    },
    checks: [],
  },
  {
    codes: ['CONTENT_TYPE_MISSING_ON_TARGET'],
    category: 'content-type',
    phase: 'schema-and-plugin-preparation',
    step: {
      id: 'prepare-content-type-registrations',
      title: 'Prepare missing content types',
      description:
        'Confirm scope and ensure the target registers approved source content types before importing their content.',
      category: 'content',
      risk: 'medium',
    },
    decision: {
      id: 'choose-content-type-scope',
      question: 'Which source-only content types should be preserved?',
      options: [
        'preserve-all-after-registration',
        'select-types-for-manual-review',
        'exclude-with-explicit-approval',
      ],
    },
    checks: [registrationChecks[0]!],
  },
  {
    codes: ['CONTENT_TYPE_CONFIGURATION_MISMATCH'],
    category: 'content-type',
    phase: 'schema-and-plugin-preparation',
    step: {
      id: 'reconcile-content-type-settings',
      title: 'Reconcile content type configuration',
      description:
        'Review differing registration settings, capabilities, and supported features before importing content; no code patches are generated.',
      category: 'content',
      risk: 'medium',
    },
    checks: [registrationChecks[0]!],
  },
  {
    codes: ['TAXONOMY_MISSING_ON_TARGET'],
    category: 'taxonomy',
    phase: 'schema-and-plugin-preparation',
    step: {
      id: 'prepare-taxonomy-registrations',
      title: 'Prepare missing taxonomies',
      description:
        'Confirm scope and ensure approved source taxonomies are registered before importing terms and content relationships.',
      category: 'taxonomy',
      risk: 'medium',
    },
    decision: {
      id: 'choose-taxonomy-scope',
      question: 'Which source-only taxonomies should be preserved?',
      options: [
        'preserve-all-after-registration',
        'select-taxonomies-for-manual-review',
        'exclude-with-explicit-approval',
      ],
    },
    checks: [registrationChecks[1]!],
  },
  {
    codes: ['TAXONOMY_CONFIGURATION_MISMATCH'],
    category: 'taxonomy',
    phase: 'schema-and-plugin-preparation',
    step: {
      id: 'reconcile-taxonomy-settings',
      title: 'Reconcile taxonomy configuration',
      description:
        'Review taxonomy hierarchy, visibility, REST/rewrite settings, and associated post types before migrating terms.',
      category: 'taxonomy',
      risk: 'medium',
    },
    checks: [registrationChecks[1]!],
  },
  {
    codes: [
      'CUSTOM_TABLE_MISSING_ON_TARGET',
      'CUSTOM_TABLE_METADATA_MISMATCH',
      'CUSTOM_TABLE_MATCH_AMBIGUOUS',
      'CUSTOM_TABLE_SCOPE_UNVERIFIED',
    ],
    category: 'database',
    phase: 'schema-and-plugin-preparation',
    step: {
      id: 'review-custom-table-provisioning',
      title: 'Review custom table ownership and provisioning',
      description:
        'Confirm table ownership and scope, plugin/schema availability, and storage compatibility before approving any table migration. Naming hints do not prove ownership; no schema creation is performed.',
      category: 'database',
      risk: 'high',
    },
    decision: {
      id: 'choose-custom-table-scope',
      question:
        'Which custom tables should be migrated, retained, or excluded after ownership and schema review?',
      options: [
        'migrate-reviewed-tables',
        'retain-target-tables',
        'defer-ambiguous-tables',
      ],
    },
    checks: [
      {
        id: 'validate-custom-table-schemas',
        title: 'Validate approved custom table schemas',
        description:
          'Review actual schemas, ownership, and plugin compatibility for approved tables; comparison metadata alone cannot establish schema compatibility.',
        category: 'database',
      },
    ],
  },
  {
    codes: ['DATABASE_CONFIGURATION_MISMATCH'],
    category: 'database',
    phase: 'schema-and-plugin-preparation',
    step: {
      id: 'review-database-compatibility',
      title: 'Review database configuration',
      description:
        'Review charset and collation differences against actual data and table requirements; do not infer that default differences require conversion.',
      category: 'database',
      risk: 'medium',
    },
    checks: [],
  },
  {
    codes: ['USER_ID_RANGE_OVERLAP'],
    category: 'user',
    phase: 'users',
    step: {
      id: 'define-user-id-strategy',
      title: 'Define user ID handling strategy',
      description:
        'Overlapping ranges risk collisions when preserving IDs. Review identities and references before approving any mapping strategy; no users are matched and no offsets or mappings are calculated.',
      category: 'users',
      risk: 'high',
    },
    decision: {
      id: 'choose-user-id-strategy',
      question:
        'How should potentially overlapping source and target user IDs be handled?',
      options: [
        'design-explicit-user-mapping',
        'assess-offset-strategy',
        'preserve-ids-only-after-collision-review',
      ],
    },
    checks: [userMappingCheck],
  },
  {
    codes: ['UPLOAD_CONFIGURATION_MISMATCH'],
    category: 'media',
    phase: 'media',
    step: {
      id: 'reconcile-upload-configuration',
      title: 'Reconcile upload configuration',
      description:
        'Choose approved upload locations and folder layout before media transfer and URL handling are planned.',
      category: 'media',
      risk: 'medium',
    },
    decision: {
      id: 'choose-upload-configuration',
      question:
        'Which upload layout and storage configuration should the destination use?',
      options: [
        'retain-target-configuration',
        'adapt-source-layout',
        'review-custom-layout',
      ],
    },
    checks: [mediaFilesCheck],
  },
  {
    codes: [
      'SOURCE_ENVIRONMENT_REFERENCES_FOUND',
      'SOURCE_DOMAIN_REFERENCES_FOUND',
      'FILESYSTEM_PATH_REFERENCES',
    ],
    category: 'url',
    phase: 'url-rewrite',
    step: {
      id: 'define-reference-policy',
      title: 'Define URL and path reference policy',
      description:
        'Decide which source-host and filesystem references should change or remain intentional. Specify serialization-safe handling without generating replacements or commands.',
      category: 'urls',
      risk: 'medium',
    },
    decision: {
      id: 'choose-reference-mapping',
      question:
        'Which source hosts and path references should map to the target, and which should remain unchanged?',
      options: [
        'design-explicit-reference-mapping',
        'retain-intentional-references',
        'defer-unverified-references',
      ],
    },
    checks: [sourceReferencesCheck],
  },
  {
    codes: ['DEVELOPMENT_URL_REFERENCES'],
    category: 'url',
    phase: 'url-rewrite',
    step: {
      id: 'review-development-references',
      title: 'Review development URL references',
      description:
        'Review local and development references on both installations and decide which are intentional.',
      category: 'urls',
      risk: 'medium',
    },
    decision: {
      id: 'choose-development-reference-policy',
      question: 'Which development references should be retained or replaced?',
      options: [
        'review-and-replace-unintended-references',
        'document-intentional-exceptions',
      ],
    },
    checks: [
      {
        id: 'validate-development-references',
        title: 'Validate development references',
        description:
          'Verify no unintended development references remain within the approved scope; documented exceptions may remain.',
        category: 'urls',
      },
    ],
  },
  {
    codes: ['UPLOAD_HOST_MISMATCH'],
    category: 'url',
    phase: 'url-rewrite',
    step: {
      id: 'review-upload-host-mapping',
      title: 'Review upload hostname handling',
      description:
        'Choose how upload hostnames should be retained or mapped while respecting storage ownership and external dependencies.',
      category: 'urls',
      risk: 'medium',
    },
    decision: {
      id: 'choose-upload-host-policy',
      question: 'How should differing upload hostnames be handled?',
      options: ['retain-approved-media-hosts', 'design-upload-host-mapping'],
    },
    checks: [mediaFilesCheck],
  },
];

export const phaseDefinitions: {
  id: MigrationPhaseId;
  name: string;
  description: string;
}[] = [
  {
    id: 'preflight',
    name: 'Preflight',
    description:
      'Confirm scope, recoverability, and the freshness of comparison evidence.',
  },
  {
    id: 'environment-preparation',
    name: 'Environment preparation',
    description: 'Resolve runtime and installation topology requirements.',
  },
  {
    id: 'schema-and-plugin-preparation',
    name: 'Schema and plugin preparation',
    description:
      'Review registrations, plugin ownership, and schema prerequisites.',
  },
  {
    id: 'users',
    name: 'Users',
    description: 'Prepare user identities, roles, and references.',
  },
  {
    id: 'content-and-taxonomies',
    name: 'Content and taxonomies',
    description: 'Plan approved content, terms, and relationship transfer.',
  },
  {
    id: 'custom-tables',
    name: 'Custom tables',
    description: 'Plan only approved custom table data and relationships.',
  },
  {
    id: 'media',
    name: 'Media',
    description: 'Prepare attachment records and approved storage handling.',
  },
  {
    id: 'url-rewrite',
    name: 'URL and path handling',
    description:
      'Review approved reference policies after data and media preparation.',
  },
  {
    id: 'validation',
    name: 'Validation',
    description:
      'Define checks to perform after a separately approved migration.',
  },
];
