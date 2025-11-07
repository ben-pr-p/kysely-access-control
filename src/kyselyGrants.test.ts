import { describe, expect, test } from "bun:test";
import {
  DummyDriver,
  Generated,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { createAccessControlPlugin } from "./kyselyAccessControl";
import { Grant, createKyselyGrantGuard } from "./kyselyGrants";

interface Person {
  id: Generated<number>;
  first_name: string | null;
  last_name: string | null;
  ssn: string | null;
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

const createPlugin = (grants: Grant<Database, any>[]) => {
  return createAccessControlPlugin(createKyselyGrantGuard(grants));
};

describe("kysely-grants", () => {
  test("simple allow", async () => {
    const plugin = createPlugin([
      {
        table: "person",
        for: "select",
      },
    ]);

    const result = await db
      .withPlugin(plugin)
      .selectFrom("person")
      .select("id")
      .execute();

    expect(result).toEqual([]);
  });

  test("should throw if no grant exists for table", async () => {
    await expectAndReturnError(
      db
        .withPlugin(createPlugin([]))
        .selectFrom("person")
        .select("id")
        .execute()
    );
  });

  test("should throw if no grant exists for table and column", async () => {
    const ex = await expectAndReturnError(
      db
        .withPlugin(
          createPlugin([
            {
              table: "person",
              for: "select",
              columns: ["id", "first_name"],
            },
          ])
        )
        .selectFrom("person")
        .select(["id", "last_name"])
        .execute()
    );

    expect(ex.message).toEqual("SELECT denied on column person.last_name");
  });

  test("all should allow all columns", async () => {
    const plugin = createPlugin([
      {
        table: "person",
        for: "select",
      },
    ]);

    const ex = await returnErrorOrUndefined(
      db
        .withPlugin(plugin)
        .selectFrom("person")
        .select(["id", "last_name"])
        .execute()
    );

    expect(ex).toBeUndefined();
  });

  test("column grant sets are union-ed", async () => {
    const plugin = createPlugin([
      {
        table: "person",
        for: "select",
        columns: ["id"],
      },
      {
        table: "person",
        for: "select",
        columns: ["first_name"],
      },
    ]);

    const ex = await returnErrorOrUndefined(
      db
        .withPlugin(plugin)
        .selectFrom("person")
        .select(["id", "first_name"])
        .execute()
    );

    expect(ex).toBeUndefined();
  });

  test("select does not imply insert", async () => {
    const plugin = createPlugin([
      {
        table: "person",
        for: "select",
        columns: ["id"],
      },
    ]);

    const ex = await expectAndReturnError(
      db
        .withPlugin(plugin)
        .insertInto("person")
        .values({ first_name: "John", last_name: "Doe" })
        .execute()
    );

    expect(ex.message).toEqual("INSERT denied on table person");
  });

  test("select on a column does not imply ability to insert that column", async () => {
    const plugin = createPlugin([
      {
        table: "person",
        for: "select",
        columns: ["id", "first_name", "last_name"],
      },
      {
        table: "person",
        for: "insert",
        columns: ["id", "first_name"],
      },
    ]);

    const ex = await expectAndReturnError(
      db
        .withPlugin(plugin)
        .insertInto("person")
        .values({ first_name: "John", last_name: "Doe" })
        .execute()
    );

    expect(ex.message).toEqual("INSERT denied on column person.last_name");
  });

  test("select on a column does enables/disables returning", async () => {
    const plugin = createPlugin([
      {
        table: "person",
        for: "select",
        columns: ["id", "first_name", "last_name"],
      },
      {
        table: "person",
        for: "insert",
        columns: ["id", "first_name"],
      },
    ]);

    const ex1 = await returnErrorOrUndefined(
      db
        .withPlugin(plugin)
        .insertInto("person")
        .values({ first_name: "John" })
        .returning(["first_name", "last_name"])
        .execute()
    );

    const ex2 = await expectAndReturnError(
      db
        .withPlugin(plugin)
        .insertInto("person")
        .values({ first_name: "John" })
        .returning(["first_name", "last_name", "ssn"])
        .execute()
    );

    expect(ex1).toBeUndefined();
    expect(ex2.message).toBe("SELECT denied on column person.ssn");
  });

  test("can return a column without update (set) permissions", async () => {
    const plugin = createPlugin([
      {
        table: "person",
        for: "select",
        columns: ["id", "first_name", "last_name"],
      },
      {
        table: "person",
        for: "update",
        columns: ["id", "first_name"],
      },
    ]);

    const ex1 = await returnErrorOrUndefined(
      db
        .withPlugin(plugin)
        .updateTable("person")
        .set({ first_name: "John" })
        .returning(["first_name", "last_name"])
        .execute()
    );

    const ex2 = await expectAndReturnError(
      db
        .withPlugin(plugin)
        .updateTable("person")
        .set({ first_name: "John", last_name: "Smith" })
        .returning(["first_name", "last_name"])
        .execute()
    );

    expect(ex1).toBeUndefined();
    expect(ex2.message).toBe("UPDATE denied on column person.last_name");
  });

  test("RLS style permissive clauses are included as a where", async () => {
    const grant: Grant<Database, "person"> = {
      table: "person",
      for: "all",
      columns: ["id", "first_name", "last_name"],
      where: (eb) => eb("person.first_name", "=", "Ben"),
    };

    const plugin = createPlugin([grant]);

    const { sql } = db
      .withPlugin(plugin)
      .selectFrom("person")
      .select(["id", "first_name", "last_name"])
      .compile();

    expect(sql).toEqual(
      `select "id", "first_name", "last_name" from "person" where "person"."first_name" = $1`
    );
  });

  test("RLS style permissive clauses are combined with other where clauses", async () => {
    const grant: Grant<Database, "person"> = {
      table: "person",
      for: "all",
      columns: ["id", "first_name", "last_name"],
      where: (eb) => eb("person.first_name", "=", "Ben"),
    };

    const plugin = createPlugin([grant]);

    const { sql } = db
      .withPlugin(plugin)
      .selectFrom("person")
      .select(["id", "first_name", "last_name"])
      .where("person.last_name", "like", "%P")
      .compile();

    expect(sql).toEqual(
      `select "id", "first_name", "last_name" from "person" where "person"."first_name" = $1 and "person"."last_name" like $2`
    );
  });

  test("combining multiple permissive and restrictive wheres results in the right and and ors", async () => {
    const grant1: Grant<Database, "person"> = {
      table: "person",
      for: "all",
      columns: ["id", "first_name", "last_name"],
      where: (eb) => eb("person.first_name", "=", "Ben"),
    };

    const grant2: Grant<Database, "person"> = {
      table: "person",
      for: "all",
      columns: ["id", "first_name", "last_name"],
      where: (eb) => eb("person.first_name", "=", "George"),
    };

    const grant3: Grant<Database, "person"> = {
      table: "person",
      for: "all",
      columns: ["id", "first_name", "last_name"],
      where: (eb) => eb("person.last_name", "=", "Smith"),
      whereType: "restrictive",
    };

    const plugin = createPlugin([grant1, grant2, grant3]);

    const { sql } = db
      .withPlugin(plugin)
      .selectFrom("person")
      .select(["id", "first_name", "last_name"])
      .where("person.id", ">", 5)
      .compile();

    expect(sql).toEqual(
      `select "id", "first_name", "last_name" from "person" where (("person"."first_name" = $1 or "person"."first_name" = $2) and "person"."last_name" = $3) and "person"."id" > $4`
    );
  });

  test("should add where clause to update query if update has where clause", async () => {
    const plugin = createPlugin([
      {
        table: "person",
        for: "select",
      },
      {
        table: "person",
        for: "update",
        where: (eb) => eb("person.id", "=", 1),
      },
    ]);

    const query = db
      .withPlugin(plugin)
      .updateTable("person")
      .set({ first_name: "Jane" })
      .where("person.id", "=", 2);

    const { sql } = query.compile();

    expect(sql).toEqual(
      `update "person" set "first_name" = $1 where "person"."id" = $2 and "person"."id" = $3`
    );
  });
});
