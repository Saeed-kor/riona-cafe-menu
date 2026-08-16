function combineOperationErrors(
  primaryError,
  cleanupErrors,
  { operationName, unknownCommitCode },
) {
  if (cleanupErrors.length === 0) {
    return primaryError;
  }

  const combinedError = new AggregateError(
    [primaryError, ...cleanupErrors],
    `${operationName} operation failed and cleanup was incomplete.`,
    { cause: primaryError },
  );

  combinedError.code = cleanupErrors.some(
    (error) => error?.code === unknownCommitCode,
  )
    ? unknownCommitCode
    : (primaryError?.code ?? 'IMAGE_OPERATION_FAILED');
  return combinedError;
}

function ambiguousCommitOutcomeError(operationName, unknownCommitCode) {
  const error = new Error(`${operationName} commit outcome could not be determined.`);
  error.code = unknownCommitCode;
  return error;
}

async function closeConnection(connection, cleanupErrors, { discard = false } = {}) {
  if (!connection) {
    return false;
  }

  try {
    if (discard && typeof connection.destroy === 'function') {
      await connection.destroy();
      return true;
    }

    await connection.release();
  } catch (error) {
    cleanupErrors.push(error);
  }

  return false;
}

async function removeStagedImage(
  storage,
  publicPath,
  cleanupErrors,
  operationName,
) {
  try {
    const removed = await storage.remove(publicPath);

    if (removed !== true) {
      cleanupErrors.push(new Error(`Staged ${operationName.toLowerCase()} cleanup was refused.`));
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
}

async function verifyReplaceCommitOutcome(
  databaseExecutor,
  entityId,
  newImagePath,
  previousImagePath,
  selectById,
) {
  const verificationErrors = [];
  let connection = null;
  let outcome = 'unknown';

  try {
    connection = await databaseExecutor.getConnection();
    const entity = await selectById(connection, entityId);

    if (entity?.imagePath === newImagePath) {
      outcome = 'committed';
    } else if (!entity || entity.imagePath === previousImagePath) {
      outcome = 'not-committed';
    }
  } catch (error) {
    verificationErrors.push(error);
  } finally {
    await closeConnection(connection, verificationErrors);
  }

  return { outcome, verificationErrors };
}

async function verifyRemoveCommitOutcome(
  databaseExecutor,
  entityId,
  previousImagePath,
  selectById,
) {
  const verificationErrors = [];
  let connection = null;
  let outcome = 'unknown';

  try {
    connection = await databaseExecutor.getConnection();
    const entity = await selectById(connection, entityId);

    if (entity?.imagePath === null) {
      outcome = 'committed';
    } else if (entity?.imagePath === previousImagePath) {
      outcome = 'not-committed';
    }
  } catch (error) {
    verificationErrors.push(error);
  } finally {
    await closeConnection(connection, verificationErrors);
  }

  return { outcome, verificationErrors };
}

export function createAdminEntityImagesService({
  executor,
  getDefaultExecutor,
  storage,
  logger = console,
  parseId,
  selectById,
  updateImagePath,
  createNotFoundError,
  removeAfterCommit,
  logCleanupFailure,
  operationName = 'Image',
  unknownCommitCode = 'IMAGE_COMMIT_OUTCOME_UNKNOWN',
  replaceReloadErrorMessage,
  removeReloadErrorMessage,
  resolveVerifiedReplaceCommit = false,
  verifyRemoveCommit = false,
  resolveVerifiedRemoveCommit = false,
  discardOnRollbackFailure = true,
} = {}) {
  const operationOptions = { operationName, unknownCommitCode };

  async function resolveExecutor() {
    return executor ?? (await getDefaultExecutor());
  }

  function logCleanup(operation, error) {
    logCleanupFailure(logger, operation, error);
  }

  return Object.freeze({
    async replace(entityIdValue, image) {
      const entityId = parseId(entityIdValue);
      const storedImage = await storage.store(image);
      let connection = null;
      let databaseExecutor = null;
      let updatedEntity = null;
      let previousImagePath = null;
      let primaryError = null;
      let transactionStarted = false;
      let commitAttempted = false;
      let commitSucceeded = false;
      let canVerifyCommit = false;
      let verifiedCommitted = false;
      let rollbackFailed = false;
      const cleanupErrors = [];

      try {
        databaseExecutor = await resolveExecutor();
        connection = await databaseExecutor.getConnection();
        await connection.beginTransaction();
        transactionStarted = true;
        const currentEntity = await selectById(connection, entityId, {
          forUpdate: true,
        });

        if (!currentEntity) {
          throw createNotFoundError();
        }

        previousImagePath = currentEntity.imagePath;
        await updateImagePath(connection, entityId, storedImage.publicPath);
        updatedEntity = await selectById(connection, entityId);

        if (!updatedEntity || updatedEntity.imagePath !== storedImage.publicPath) {
          throw new Error(
            replaceReloadErrorMessage ??
              `Updated ${operationName.toLowerCase()} could not be loaded.`,
          );
        }

        commitAttempted = true;
        await connection.commit();
        commitSucceeded = true;
        transactionStarted = false;
      } catch (error) {
        primaryError = error;

        if (transactionStarted && !commitAttempted) {
          try {
            await connection.rollback();
            transactionStarted = false;
          } catch (rollbackError) {
            cleanupErrors.push(rollbackError);
            rollbackFailed = true;
          }
        }
      } finally {
        if (connection) {
          if (commitSucceeded) {
            const releaseErrors = [];
            await closeConnection(connection, releaseErrors);

            for (const releaseError of releaseErrors) {
              logCleanup('release-connection', releaseError);
            }
          } else {
            canVerifyCommit = await closeConnection(connection, cleanupErrors, {
              discard: commitAttempted ||
                (discardOnRollbackFailure && rollbackFailed),
            });
          }
        }
      }

      if (primaryError) {
        if (!commitAttempted) {
          await removeStagedImage(
            storage,
            storedImage.publicPath,
            cleanupErrors,
            operationName,
          );
        } else if (canVerifyCommit) {
          const { outcome, verificationErrors } = await verifyReplaceCommitOutcome(
            databaseExecutor,
            entityId,
            storedImage.publicPath,
            previousImagePath,
            selectById,
          );
          cleanupErrors.push(...verificationErrors);

          if (outcome === 'committed') {
            await removeAfterCommit(storage, previousImagePath, logger);
            verifiedCommitted = resolveVerifiedReplaceCommit;
          } else if (outcome === 'not-committed') {
            await removeStagedImage(
              storage,
              storedImage.publicPath,
              cleanupErrors,
              operationName,
            );
          } else {
            cleanupErrors.push(
              ambiguousCommitOutcomeError(operationName, unknownCommitCode),
            );
          }
        } else {
          cleanupErrors.push(
            ambiguousCommitOutcomeError(operationName, unknownCommitCode),
          );
        }

        if (verifiedCommitted) {
          logCleanup('commit-acknowledgement', primaryError);

          for (const cleanupError of cleanupErrors) {
            logCleanup('verification-connection', cleanupError);
          }

          return updatedEntity;
        }

        throw combineOperationErrors(primaryError, cleanupErrors, operationOptions);
      }

      await removeAfterCommit(storage, previousImagePath, logger);
      return updatedEntity;
    },

    async remove(entityIdValue) {
      const entityId = parseId(entityIdValue);
      const databaseExecutor = await resolveExecutor();
      let connection = null;
      let updatedEntity = null;
      let previousImagePath = null;
      let primaryError = null;
      let transactionStarted = false;
      let commitAttempted = false;
      let commitSucceeded = false;
      let canVerifyCommit = false;
      let verifiedCommitted = false;
      let rollbackFailed = false;
      const cleanupErrors = [];

      try {
        connection = await databaseExecutor.getConnection();
        await connection.beginTransaction();
        transactionStarted = true;
        const currentEntity = await selectById(connection, entityId, {
          forUpdate: true,
        });

        if (!currentEntity) {
          throw createNotFoundError();
        }

        previousImagePath = currentEntity.imagePath;

        if (previousImagePath) {
          await updateImagePath(connection, entityId, null);
          updatedEntity = await selectById(connection, entityId);

          if (!updatedEntity || updatedEntity.imagePath !== null) {
            throw new Error(
              removeReloadErrorMessage ??
                `${operationName} without a file could not be loaded.`,
            );
          }
        } else {
          updatedEntity = currentEntity;
        }

        commitAttempted = true;
        await connection.commit();
        commitSucceeded = true;
        transactionStarted = false;
      } catch (error) {
        primaryError = error;

        if (transactionStarted && !commitAttempted) {
          try {
            await connection.rollback();
            transactionStarted = false;
          } catch (rollbackError) {
            cleanupErrors.push(rollbackError);
            rollbackFailed = true;
          }
        }
      } finally {
        if (connection) {
          if (commitSucceeded) {
            const releaseErrors = [];
            await closeConnection(connection, releaseErrors);

            for (const releaseError of releaseErrors) {
              logCleanup('release-connection', releaseError);
            }
          } else {
            canVerifyCommit = await closeConnection(connection, cleanupErrors, {
              discard: commitAttempted ||
                (discardOnRollbackFailure && rollbackFailed),
            });
          }
        }
      }

      if (primaryError) {
        if (commitAttempted && verifyRemoveCommit && canVerifyCommit) {
          const { outcome, verificationErrors } = await verifyRemoveCommitOutcome(
            databaseExecutor,
            entityId,
            previousImagePath,
            selectById,
          );
          cleanupErrors.push(...verificationErrors);

          if (outcome === 'committed') {
            await removeAfterCommit(storage, previousImagePath, logger);
            verifiedCommitted = resolveVerifiedRemoveCommit;
          } else if (outcome === 'unknown') {
            cleanupErrors.push(
              ambiguousCommitOutcomeError(operationName, unknownCommitCode),
            );
          }
        } else if (commitAttempted) {
          cleanupErrors.push(
            ambiguousCommitOutcomeError(operationName, unknownCommitCode),
          );
        }

        if (verifiedCommitted) {
          logCleanup('commit-acknowledgement', primaryError);

          for (const cleanupError of cleanupErrors) {
            logCleanup('verification-connection', cleanupError);
          }

          return updatedEntity;
        }

        throw combineOperationErrors(primaryError, cleanupErrors, operationOptions);
      }

      await removeAfterCommit(storage, previousImagePath, logger);
      return updatedEntity;
    },
  });
}
