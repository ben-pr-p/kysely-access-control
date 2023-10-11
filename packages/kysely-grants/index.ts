import {
  ExpressionBuilder,
  ExpressionWrapper,
  expressionBuilder,
  SqlBool,
} from "kysely";
import {
  Allow,
  ColumnUsageContext,
  Deny,
  KyselyAccessControlGuard,
  StatementType,
} from "kysely-access-control";

type GrantWithoutWhereClause<
  KyselyDatabase,
  TableName extends keyof KyselyDatabase
> = {
  table: TableName;
  schema?: string;
  for: "all" | "select" | "update" | "insert" | "delete";
  columns?: (keyof KyselyDatabase[TableName])[];
};

type GrantWithWhereClause<
  KyselyDatabase,
  TableName extends keyof KyselyDatabase
> = GrantWithoutWhereClause<KyselyDatabase, TableName> & {
  where: (
    eb: ExpressionBuilder<KyselyDatabase, TableName>
  ) => ExpressionWrapper<KyselyDatabase, TableName, SqlBool>;
  whereType?: "permissive" | "restrictive";
};

export type Grant<KyselyDatabase, TableName extends keyof KyselyDatabase> =
  | GrantWithWhereClause<KyselyDatabase, TableName>
  | GrantWithoutWhereClause<KyselyDatabase, TableName>;

const isGrantWithWhereClause = <
  KyselyDatabase,
  TableName extends keyof KyselyDatabase
>(
  grant: Grant<KyselyDatabase, TableName>
): grant is GrantWithWhereClause<KyselyDatabase, TableName> => "where" in grant;

export const createKyselyGrantGuard = <KyselyDatabase>(
  grants: Grant<KyselyDatabase, any>[]
) => {
  const guard: KyselyAccessControlGuard = {
    table: (table, statementType) => {
      const allowGrants = grants.filter((grant) => {
        return (
          (grant.schema === undefined || grant.schema === table.schema?.name) &&
          grant.table === table.identifier.name &&
          (grant.for === "all" || grant.for === statementType)
        );
      });

      if (allowGrants.length === 0) {
        return Deny;
      }

      // Now that we know we're allowing, we create all RLS
      const grantsWithWheres = allowGrants.filter(isGrantWithWhereClause);

      const grantsWithRestrictiveWheres = grantsWithWheres.filter(
        (grant) => grant.whereType === "restrictive"
      );

      // Permissive is the default
      const grantsWithPermissiveWheres = grantsWithWheres.filter(
        (grant) => grant.whereType !== "restrictive"
      );

      if (
        grantsWithRestrictiveWheres.length === 0 &&
        grantsWithPermissiveWheres.length === 0
      ) {
        return Allow;
      }

      if (
        grantsWithPermissiveWheres.length === 0 &&
        grantsWithRestrictiveWheres.length > 0
      ) {
        // No rows will be returned - see https://www.postgresql.org/docs/current/sql-createpolicy.html
        return [Allow, expressionBuilder().lit(false)];
      }

      const permissiveEbs = expressionBuilder().or(
        grantsWithPermissiveWheres.map((grant) =>
          grant.where(expressionBuilder())
        )
      );

      if (grantsWithRestrictiveWheres.length > 0) {
        // And the or of the permissives and the and of the restrictives
        return [
          Allow,
          expressionBuilder().and([
            permissiveEbs,
            expressionBuilder().and(
              grantsWithRestrictiveWheres.map((grant) =>
                grant.where(expressionBuilder())
              )
            ),
          ]),
        ];
      } else {
        return [Allow, permissiveEbs];
      }
    },

    column: (table, column, statementType, columnUsageContext) => {
      const allowGrant = grants.find((grant) => {
        const rightSchemaAndTableAndColumns =
          (grant.schema === undefined || grant.schema === table.schema?.name) &&
          grant.table === table.identifier.name &&
          (grant.columns === undefined ||
            (Array.isArray(grant.columns) &&
              // TODO - retype this when column node is typed
              grant.columns.includes(column.name as any)));

        if (!rightSchemaAndTableAndColumns) {
          return false;
        }

        if (grant.for === "all") {
          return true;
        }

        if (
          grant.for === StatementType.Select &&
          (
            [
              ColumnUsageContext.ColumnInSelectOrReturning,
              ColumnUsageContext.ColumnInWhereOrJoin,
            ] as string[]
          ).includes(columnUsageContext)
        ) {
          return true;
        }

        if (
          grant.for === StatementType.Update &&
          ColumnUsageContext.ColumnInUpdateSet === columnUsageContext
        ) {
          return true;
        }

        if (
          grant.for === StatementType.Insert &&
          ColumnUsageContext.ColumnInInsert === columnUsageContext
        ) {
          return true;
        }

        return false;
      });

      if (!allowGrant) {
        return Deny;
      }

      return Allow;
    },
  };

  return guard;
};
