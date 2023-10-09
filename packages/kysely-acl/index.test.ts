import { expect, test, describe, mock } from "bun:test";
import {
  KyselyAclGuard,
  createAclPlugin,
  Allow,
  Deny,
  Omit,
  StatementType,
  TableUsageContext,
  ColumnUsageContext,
} from ".";

import {
  Generated,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  expressionBuilder,
} from "kysely";

interface Person {
  id: Generated<number>;
  first_name: string;
  last_name: string | null;
}

interface Event {
  id: Generated<number>;
  name: string;
  location: string;
  date: Date;
}

interface RSVP {
  id: Generated<number>;
  person_id: number;
  event_id: number;
  attended: boolean;
}

interface Database {
  person: Person;
  event: Event;
  rsvp: RSVP;
}

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const expectAndReturnError = async (promise: Promise<unknown>) => {
  let ex: Error;

  try {
    await promise;
    throw new Error("No error thrown");
  } catch (e: unknown) {
    ex = e as Error;
    return ex;
  }
};

const returnErrorOrUndefined = async (promise: Promise<unknown>) => {
  let ex: Error;

  try {
    await promise;
    return undefined;
  } catch (e: unknown) {
    ex = e as Error;
    return ex;
  }
};

describe("kysely-acl", () => {
  test("should invoke guard for table", async () => {
    const tableMock = mock(() => Allow);

    const guard: KyselyAclGuard = {
      table: tableMock,
    };

    await db
      .withPlugin(createAclPlugin(guard))
      .selectFrom("person")
      .select("person.id")
      .execute();

    expect(tableMock).toHaveBeenCalled();
  });

  test("should throw if table guard returns deny", async () => {
    const tableMock = mock(() => Deny);

    const guard: KyselyAclGuard = {
      table: tableMock,
    };

    const ex = await expectAndReturnError(
      db
        .withPlugin(createAclPlugin(guard))
        .selectFrom("person")
        .select(["person.id"])
        .execute()
    );

    expect(ex.message).toBe("SELECT denied on table person");
  });

  test("should throw for update only", async () => {
    const tableMock = mock((table, action) =>
      action === StatementType.Update ? Deny : Allow
    );

    const guard: KyselyAclGuard = {
      table: tableMock,
    };

    const noEx = await returnErrorOrUndefined(
      db
        .withPlugin(createAclPlugin(guard))
        .selectFrom("person")
        .select(["person.id"])
        .execute()
    );

    const ex = await expectAndReturnError(
      db
        .withPlugin(createAclPlugin(guard))
        .updateTable("person")
        .set({ first_name: "John" })
        .execute()
    );

    expect(noEx).toBeUndefined();
    expect(ex.message).toBe("UPDATE denied on table person");
  });

  test("should throw for insert only", async () => {
    const tableMock = mock((table, action) =>
      action === StatementType.Insert ? Deny : Allow
    );

    const guard: KyselyAclGuard = {
      table: tableMock,
    };

    const noEx = await returnErrorOrUndefined(
      db
        .withPlugin(createAclPlugin(guard))
        .selectFrom("person")
        .select(["person.id"])
        .execute()
    );

    const ex = await expectAndReturnError(
      db
        .withPlugin(createAclPlugin(guard))
        .insertInto("person")
        .values({ first_name: "John" })
        .execute()
    );

    expect(noEx).toBeUndefined();
    expect(ex.message).toBe("INSERT denied on table person");
  });

  test("should throw for delete only", async () => {
    const tableMock = mock((table, action) =>
      action === StatementType.Delete ? Deny : Allow
    );

    const guard: KyselyAclGuard = {
      table: tableMock,
    };

    const noEx = await returnErrorOrUndefined(
      db
        .withPlugin(createAclPlugin(guard))
        .selectFrom("person")
        .select("person.id")
        .execute()
    );

    const ex = await expectAndReturnError(
      db.withPlugin(createAclPlugin(guard)).deleteFrom("person").execute()
    );

    expect(noEx).toBeUndefined();
    expect(ex.message).toBe("DELETE denied on table person");
  });

  test("column selections should throw on deny", async () => {
    const guard: KyselyAclGuard = {
      column: (table, column) => (column.name === "last_name" ? Deny : Allow),
    };

    const ex = await expectAndReturnError(
      db
        .withPlugin(createAclPlugin(guard))
        .selectFrom("person")
        .innerJoin("rsvp", "rsvp.person_id", "person.id")
        .select(["person.first_name", "person.last_name"])
        .execute()
    );

    expect(ex.message).toBe("SELECT denied on column person.last_name");
  });

  test("column selections should be omitted on omit for select", async () => {
    const guard: KyselyAclGuard = {
      column: (table, column) => (column.name === "last_name" ? Omit : Allow),
    };

    const compiledQuery = db
      .withPlugin(createAclPlugin(guard))
      .selectFrom("person")
      .select(["person.first_name", "person.last_name"])
      .compile();

    // Last name is missing
    expect(compiledQuery.sql).toBe(
      `select "person"."first_name" from "person"`
    );
  });

  test("column selections should be omitted on omit for insert/update returning", async () => {
    const guard: KyselyAclGuard = {
      column: (table, column) => (column.name === "last_name" ? Omit : Allow),
    };

    const compiledInsert = db
      .withPlugin(createAclPlugin(guard))
      .insertInto("person")
      .values({ first_name: "Ben" })
      .returning(["person.first_name", "person.last_name"])
      .compile();

    const compiledUpdate = db
      .withPlugin(createAclPlugin(guard))
      .updateTable("person")
      .set({ first_name: "Ben" })
      .returning(["person.first_name", "person.last_name"])
      .compile();

    // Last name is missing
    expect(compiledInsert.sql).toBe(
      `insert into "person" ("first_name") values ($1) returning "person"."first_name"`
    );

    expect(compiledUpdate.sql).toBe(
      `update "person" set "first_name" = $1 returning "person"."first_name"`
    );
  });

  test("can separately control table usage in join vs. top level select", async () => {
    const joinAllowedGuard: KyselyAclGuard<Database> = {
      table: (table, _statementType, tableUsageContext) => {
        if (table.identifier.name === "rsvp") {
          if (tableUsageContext === TableUsageContext.TableInJoin) {
            return Allow;
          }
          return Deny;
        }
        return Allow;
      },
    };

    const joinDisallowedGuard: KyselyAclGuard<Database> = {
      table: (table, _statementType, tableUsageContext) => {
        if (table.identifier.name === "rsvp") {
          if (tableUsageContext === TableUsageContext.TableInJoin) {
            return Deny;
          }
          return Deny;
        }
        return Allow;
      },
    };

    const topLevelRsvp = await expectAndReturnError(
      db
        .withPlugin(createAclPlugin(joinAllowedGuard))
        .selectFrom("rsvp")
        .select(["rsvp.id"])
        .execute()
    );

    const usageInJoin = await returnErrorOrUndefined(
      db
        .withPlugin(createAclPlugin(joinAllowedGuard))
        .selectFrom("person")
        .innerJoin("rsvp", "rsvp.person_id", "person.id")
        .select(["person.id"])
        .execute()
    );

    const usageInJoinDisallowed = await expectAndReturnError(
      db
        .withPlugin(createAclPlugin(joinDisallowedGuard))
        .selectFrom("person")
        .innerJoin("rsvp", "rsvp.person_id", "person.id")
        .select(["person.id"])
        .execute()
    );

    expect(usageInJoin).toBeUndefined();
    expect(topLevelRsvp.message).toBe("SELECT denied on table rsvp");
    expect(usageInJoinDisallowed.message).toBe("JOIN denied on table rsvp");
  });

  test("can separately control column usage in filter vs select", async () => {
    const filterAllowedAndSelectDisallowedGuard = createAclPlugin({
      column: (_table, column, _statementType, columnUsageContext) => {
        if (column.name === "last_name") {
          if (columnUsageContext === ColumnUsageContext.ColumnInWhereOrJoin) {
            return Allow;
          }
          return Deny;
        }
        return Allow;
      },
    });

    const filterDisallowedAndSelectAllowedGuard = createAclPlugin({
      column: (_table, column, _statementType, columnUsageContext) => {
        if (column.name === "last_name") {
          if (columnUsageContext === ColumnUsageContext.ColumnInWhereOrJoin) {
            return Deny;
          }
          return Allow;
        }
        return Allow;
      },
    });

    const allowedUsageInSelect = await returnErrorOrUndefined(
      db
        .withPlugin(filterDisallowedAndSelectAllowedGuard)
        .selectFrom("person")
        .select(["person.id", "person.last_name"])
        .execute()
    );

    const disallowedUsageInFilter = await expectAndReturnError(
      db
        .withPlugin(filterDisallowedAndSelectAllowedGuard)
        .selectFrom("person")
        .where("person.last_name", "=", "Doe")
        .select(["person.id"])
        .execute()
    );

    const allowedUsageInFilter = await returnErrorOrUndefined(
      db
        .withPlugin(filterAllowedAndSelectDisallowedGuard)
        .selectFrom("person")
        .where("person.last_name", "=", "Doe")
        .select(["person.id"])
        .execute()
    );

    const disallowedUsageInSelect = await expectAndReturnError(
      db
        .withPlugin(filterAllowedAndSelectDisallowedGuard)
        .selectFrom("person")
        .select(["person.id", "person.last_name"])
        .execute()
    );

    expect(allowedUsageInSelect).toBeUndefined();
    expect(disallowedUsageInFilter.message).toBe(
      "SELECT denied on column person.last_name"
    );
    expect(allowedUsageInFilter).toBeUndefined();
    expect(disallowedUsageInSelect.message).toBe(
      "SELECT denied on column person.last_name"
    );
  });

  test("can separately control column usage in join vs select", async () => {
    const joinAllowedAndSelectDisallowedGuard = createAclPlugin({
      column: (_table, column, _statementType, columnUsageContext) => {
        if (column.name === "id") {
          if (columnUsageContext === ColumnUsageContext.ColumnInWhereOrJoin) {
            return Allow;
          }
          return Deny;
        }
        return Allow;
      },
    });

    const joinDisallowedAndSelectAllowedGuard = createAclPlugin({
      column: (_table, column, _statementType, columnUsageContext) => {
        if (column.name === "id") {
          if (columnUsageContext === ColumnUsageContext.ColumnInWhereOrJoin) {
            return Deny;
          }
          return Allow;
        }
        return Allow;
      },
    });

    const allowedUsageInJoin = await returnErrorOrUndefined(
      db
        .withPlugin(joinAllowedAndSelectDisallowedGuard)
        .selectFrom("person")
        .innerJoin("rsvp", "rsvp.person_id", "person.id")
        .select(["person.first_name"])
        .execute()
    );

    const disallowedUsageInSelect = await expectAndReturnError(
      db
        .withPlugin(joinAllowedAndSelectDisallowedGuard)
        .selectFrom("person")
        .select(["person.id"])
        .execute()
    );

    const allowedUsageInSelect = await returnErrorOrUndefined(
      db
        .withPlugin(joinDisallowedAndSelectAllowedGuard)
        .selectFrom("person")
        .select(["person.id"])
        .execute()
    );

    const disallowedUsageInJoin = await expectAndReturnError(
      db
        .withPlugin(joinDisallowedAndSelectAllowedGuard)
        .selectFrom("person")
        .innerJoin("rsvp", "rsvp.person_id", "person.id")
        .select(["person.first_name"])
        .execute()
    );

    expect(allowedUsageInJoin).toBeUndefined();
    expect(disallowedUsageInSelect.message).toBe(
      "SELECT denied on column person.id"
    );
    expect(allowedUsageInSelect).toBeUndefined();
    expect(disallowedUsageInJoin.message).toBe(
      "FILTER denied on column person.id"
    );
  });

  test("can separately control column usage in set vs select", async () => {
    const updateAllowedAndSelectDisallowedGuard = createAclPlugin({
      column: (_table, column, _statementType, columnUsageContext) => {
        if (column.name === "first_name") {
          if (columnUsageContext === ColumnUsageContext.ColumnInUpdateSet) {
            return Allow;
          }
          return Deny;
        }
        return Allow;
      },
    });

    const updateDisallowedAndSelectAllowedGuard = createAclPlugin({
      column: (_table, column, _statementType, columnUsageContext) => {
        if (column.name === "first_name") {
          if (columnUsageContext === ColumnUsageContext.ColumnInUpdateSet) {
            return Deny;
          }
          return Allow;
        }
        return Allow;
      },
    });

    const allowedUsageInUpdate = await returnErrorOrUndefined(
      db
        .withPlugin(updateAllowedAndSelectDisallowedGuard)
        .updateTable("person")
        .set({ first_name: "John" })
        .returning(["person.id"]) // dont return first_name, that's not allowed
        .execute()
    );

    const disallowedUsageInSelect = await expectAndReturnError(
      db
        .withPlugin(updateAllowedAndSelectDisallowedGuard)
        .selectFrom("person")
        .select(["person.first_name"])
        .execute()
    );

    const allowedUsageInSelect = await returnErrorOrUndefined(
      db
        .withPlugin(updateDisallowedAndSelectAllowedGuard)
        .selectFrom("person")
        .select(["person.id"])
        .execute()
    );

    const disallowedUsageInUpdate = await expectAndReturnError(
      db
        .withPlugin(updateDisallowedAndSelectAllowedGuard)
        .updateTable("person")
        .set({ first_name: "John" })
        .returning(["person.first_name"])
        .execute()
    );

    expect(allowedUsageInUpdate).toBeUndefined();
    expect(disallowedUsageInSelect.message).toBe(
      "SELECT denied on column person.first_name"
    );
    expect(allowedUsageInSelect).toBeUndefined();
    expect(disallowedUsageInUpdate.message).toBe(
      "UPDATE denied on column person.first_name"
    );
  });

  test("can enforce RLS on joined tables in select/insert/update/delete", async () => {
    // RLS policy so only people with first_name Ben can be selected
    const guard: KyselyAclGuard<Database> = {
      table: (table, _statementType, tableUsageContext) => {
        if (table.identifier.name === "person") {
          return [
            Allow,
            expressionBuilder<Database, "person">().eb(
              "person.first_name",
              "=",
              "Ben"
            ),
          ];
        }
        return Allow;
      },
    };

    // Compiled a join from events to people
    const compiledSelect = db
      .withPlugin(createAclPlugin(guard))
      .selectFrom("event")
      .innerJoin("rsvp", "rsvp.event_id", "event.id")
      .innerJoin("person", "person.id", "rsvp.person_id")
      .select(["person.id", "person.first_name"])
      .compile();

    expect(compiledSelect.sql).toBe(
      `select "person"."id", "person"."first_name" from "event" inner join "rsvp" on "rsvp"."event_id" = "event"."id" inner join (select * from "person" where "person"."first_name" = $1) as "person" on "person"."id" = "rsvp"."person_id"`
    );

    const compiledUpdate = db
      .withPlugin(createAclPlugin(guard))
      .updateTable("rsvp")
      .from("person")
      .set({ attended: true })
      .whereRef("rsvp.person_id", "=", "person.id")
      .compile();

    expect(compiledUpdate.sql).toBe(
      `update "rsvp" set "attended" = $1 from (select * from "person" where "person"."first_name" = $2) as "person" where "rsvp"."person_id" = "person"."id"`
    );

    const compiledDelete = db
      .withPlugin(createAclPlugin(guard))
      .deleteFrom("rsvp")
      .using("person")
      .whereRef("rsvp.person_id", "=", "person.id")
      .compile();

    expect(compiledDelete.sql).toBe(
      `delete from "rsvp" using (select * from "person" where "person"."first_name" = $1) as "person" where "rsvp"."person_id" = "person"."id"`
    );
  });
});
