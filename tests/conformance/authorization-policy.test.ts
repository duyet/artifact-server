import {Effect, Layer, ManagedRuntime, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {AuthorizationService} from "../../src/application/authorization.js";
import type {AuthorizationDenied} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import type {ArtifactRecord} from "../../src/core/model.js";

describe("authorization policy", () => {
  let runtime: ManagedRuntime.ManagedRuntime<AuthorizationService, never>;

  beforeEach(async () => {
    runtime = ManagedRuntime.make(Layer.mergeAll(
      AuthorizationService.layer({
        installationId: "installation-a",
        publicLinks: "allowed",
      }),
    ));
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  test("AUTH-008-B AUTH-008-F: standalone mutations use membership and explicit capabilities", async () => {
    expect.hasAssertions();
    const artifact = artifactFixture();
    const member = humanPrincipal("member", membershipRoles.member);
    const administrator = humanPrincipal(
      "administrator",
      membershipRoles.administrator,
    );
    const scopedService = servicePrincipal(
      "publisher",
      [principalCapabilities.publishAnyArtifact],
    );
    const readerService = servicePrincipal(
      "reader",
      [principalCapabilities.readArtifacts],
    );
    const managerService = servicePrincipal(
      "manager",
      [principalCapabilities.manageAnyArtifact],
    );
    const unscopedService = servicePrincipal("reader", []);

    await expectAllowed((authorization) =>
      authorization.requireArtifactRead(member)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactListing(member)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactRead(readerService)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(member)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(administrator)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(managerService)
    );
    await expectAllowed((authorization) =>
      authorization.requireContentSession(member, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(member, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(administrator, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(scopedService, artifact)
    );
    await expectDenied((authorization) =>
      authorization.requireVersionPublication(unscopedService, artifact)
    );
    // A creator keeps publishing what it owns and nothing else.
    const creator = servicePrincipal(
      artifact.owner.principalId,
      [principalCapabilities.createArtifact],
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(creator, artifact)
    );
    await expectDenied((authorization) =>
      authorization.requireVersionPublication(
        {...creator, id: "another-creator"},
        artifact,
      )
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactRead(unscopedService)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactListing(unscopedService).pipe(Effect.asVoid)
    );
  });

  test("foundation: another installation or an unscoped service cannot acquire authority", async () => {
    expect.hasAssertions();
    const artifact = artifactFixture();
    const foreignAdministrator: Principal = {
      ...humanPrincipal("foreign-admin", membershipRoles.administrator),
      installationId: "installation-b",
    };
    await expectDenied((authorization) =>
      authorization.requireContentSession(foreignAdministrator, artifact)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactCreation(servicePrincipal("unscoped", []))
    );
  });

  test("artifact visibility belongs to the owner, an administrator, or an artifact manager", async () => {
    expect.hasAssertions();
    const artifact = artifactFixture();
    const owner = artifact.owner.principalId;
    const ownMemberKey: Principal = {
      ...humanPrincipal(owner, membershipRoles.member),
      authorizedByPrincipalId: "administrator",
      capabilities: [principalCapabilities.createArtifact],
    };
    const otherMember = humanPrincipal("other-member", membershipRoles.member);
    const otherMemberKey: Principal = {
      ...ownMemberKey,
      id: "other-member",
    };
    const administrator = humanPrincipal(
      "administrator",
      membershipRoles.administrator,
    );
    const manager = servicePrincipal(
      "manager",
      [principalCapabilities.manageAnyArtifact],
    );
    const foreignOwner: Principal = {
      ...humanPrincipal(owner, membershipRoles.member),
      installationId: "installation-b",
    };
    // Keys on the owner's principal scoped below creation do not own it.
    const ownReaderKey: Principal = {
      ...ownMemberKey,
      capabilities: [principalCapabilities.readArtifacts],
    };
    const ownCommenterKey: Principal = {
      ...ownMemberKey,
      capabilities: [principalCapabilities.writeComments],
    };
    const ownContentSessionKey: Principal = {
      ...ownMemberKey,
      capabilities: [principalCapabilities.issueContentSession],
    };

    await Promise.all([
      humanPrincipal(owner, membershipRoles.member),
      ownMemberKey,
      administrator,
      manager,
    ].map((allowed) =>
      expectAllowed((authorization) =>
        authorization.requireArtifactOwnership(allowed, artifact)
      )
    ));
    await Promise.all([
      otherMember,
      otherMemberKey,
      foreignOwner,
      ownReaderKey,
      ownCommenterKey,
      ownContentSessionKey,
    ].map((refused) =>
      expectDenied((authorization) =>
        authorization.requireArtifactOwnership(refused, artifact)
      )
    ));
    // A direct human member who does not own the artifact still manages its
    // other metadata, which is what keeps non-visibility tag edits open.
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(otherMember)
    );
    const decisions = await runtime.runPromise(AuthorizationService.use(
      (authorization) => Effect.succeed([
        authorization.canManageArtifact(ownMemberKey, artifact),
        authorization.canManageArtifact(otherMember, artifact),
      ]),
    ));
    expect(decisions).toEqual([true, false]);
  });

  test("project discovery follows membership and explicit service authority", async () => {
    expect.hasAssertions();
    const member = humanPrincipal("member", membershipRoles.member);
    const administrator = humanPrincipal(
      "administrator",
      membershipRoles.administrator,
    );
    const reader = servicePrincipal(
      "reader",
      [principalCapabilities.readArtifacts],
    );
    const projectManager = servicePrincipal(
      "project-manager",
      [principalCapabilities.manageProjects],
    );
    const unscoped = servicePrincipal("unscoped", []);
    const foreignAdministrator: Principal = {
      ...administrator,
      installationId: "installation-b",
    };

    await expectAllowed((authorization) =>
      authorization.requireProjectAccess(member)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectAccess(reader)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectAccess(projectManager)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectManagement(administrator)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectManagement(projectManager)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectManagement(member)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectAccess(unscoped)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectAccess(foreignAdministrator)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectManagement(foreignAdministrator)
    );
  });

  async function expectAllowed(
    operation: (
      authorization: AuthorizationService["Service"],
    ) => Effect.Effect<void, AuthorizationDenied>,
  ): Promise<void> {
    const result = await runtime.runPromise(
      Effect.result(AuthorizationService.use(operation)),
    );
    expect(Result.isSuccess(result)).toBe(true);
  }

  async function expectDenied(
    operation: (
      authorization: AuthorizationService["Service"],
    ) => Effect.Effect<void, AuthorizationDenied>,
  ): Promise<void> {
    const result = await runtime.runPromise(
      Effect.result(AuthorizationService.use(operation)),
    );
    expect(Result.match(result, {
      onFailure: (failure) => failure._tag,
      onSuccess: () => "UnexpectedSuccess",
    })).toBe("AuthorizationDenied");
  }
});

function artifactFixture(): ArtifactRecord {
  return {
    accessSetting: "account_required",
    createdAt: "2026-08-13T00:00:00.000Z",
    currentVersionId: "version-1",
    deletedAt: null,
    id: "artifact-1",
    name: "Authorization fixture",
    owner: {displayName: "Fixture owner", principalId: "principal-1"},
    path: null,
    projectId: "prj_default",
    tags: [],
  };
}

function humanPrincipal(
  id: string,
  membershipRole: Principal["membershipRole"],
): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Policy human",
    id,
    installationId: "installation-a",
    kind: principalKinds.human,
    membershipRole,
  };
}

function servicePrincipal(
  id: string,
  capabilities: Principal["capabilities"],
): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities,
    displayName: "Policy service",
    id,
    installationId: "installation-a",
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
  };
}
