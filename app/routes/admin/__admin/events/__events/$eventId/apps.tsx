import type { App, EventAppPlatform, Platform, Studio } from "~/prisma-client";
import { PlatformType } from "~/prisma-client";
import { AppType } from "~/prisma-client";
import { EventAppPlatformStatus } from "~/prisma-client";
import { Link, Outlet, useFetcher, useSearchParams } from "@remix-run/react";
import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { omit } from "lodash";
import { Fragment } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { zfd } from "zod-form-data";
import { prisma } from "~/db.server";
import { requireAdminUser } from "~/session.server";
import type { PageHandle } from "~/types/remix";
import qs from "qs";
import type { Entries } from "type-fest";
import { isPlatformStatusOK } from "~/models/events";
import EmptyOption from "~/components/EmptyOption";

enum Intent {
  EditPlatform = "save-platform",
  AddPlatform = "add-platform",
  DeletePlatform = "delete-platform",
}

const actionSchema = z.union([
  zfd.formData({
    intent: zfd.text(z.literal(Intent.DeletePlatform)),
    eventAppPlatformId: zfd.text(),
  }),
  zfd.formData({
    intent: zfd.text(z.literal(Intent.EditPlatform)),
    eventAppPlatformId: zfd.text(),
    status: z.enum(
      Object.keys(EventAppPlatformStatus) as [
        EventAppPlatformStatus,
        EventAppPlatformStatus[number]
      ]
    ),
    comment: zfd
      .text(z.string().optional())
      .transform((arg) => (typeof arg === "undefined" ? null : arg)),
  }),
  zfd.formData({
    intent: zfd.text(z.literal(Intent.AddPlatform)),
    appPlatformId: zfd.text(),
    status: z.enum(
      Object.keys(EventAppPlatformStatus) as [
        EventAppPlatformStatus,
        EventAppPlatformStatus[number]
      ]
    ),
    comment: zfd
      .text(z.string().optional())
      .transform((arg) => (typeof arg === "undefined" ? null : arg)),
  }),
]);

export async function action({ request, params }: ActionArgs) {
  await requireAdminUser(request);
  invariant(params.eventId, "Invalid event ID");

  const formData = await request.formData();
  const data = actionSchema.parse(formData);

  switch (data.intent) {
    case Intent.DeletePlatform: {
      await prisma.eventAppPlatform.delete({
        where: { id: data.eventAppPlatformId },
      });
      return redirect(request.url);
    }
    case Intent.EditPlatform: {
      await prisma.eventAppPlatform.update({
        where: { id: data.eventAppPlatformId },
        data: {
          status: data.status as never,
          comment: data.comment ?? null,
        },
      });
      return redirect(request.url);
    }
    case Intent.AddPlatform: {
      await prisma.eventAppPlatform.create({
        data: {
          eventId: params.eventId,
          appPlatformId: data.appPlatformId,
          status: data.status as never,
          comment: data.comment ?? null,
        },
      });
      return redirect(request.url);
    }
    default: {
      throw new Error("Invalid intent");
    }
  }
}

export async function getApps(eventId: string) {
  const eventAppPlatforms = await prisma.eventAppPlatform.findMany({
    where: { eventId },
    include: {
      appPlatform: {
        include: { platform: true, app: true, links: true },
      },
    },
    orderBy: { appPlatform: { app: { name: "asc" } } },
  });

  type AppData = typeof eventAppPlatforms[number]["appPlatform"]["app"] & {
    appPlatforms: Array<
      Omit<typeof eventAppPlatforms[number]["appPlatform"], "app"> & {
        eventAppPlatform: Pick<EventAppPlatform, "id" | "status" | "comment">;
      }
    >;
  };
  const appsMap = new Map<App["id"], AppData>();
  const platformsMap = new Map<
    Platform["id"],
    Pick<Platform, "id" | "name" | "type">
  >();

  eventAppPlatforms.forEach((eventAppPlatform) => {
    if (!appsMap.has(eventAppPlatform.appPlatform.appId)) {
      appsMap.set(eventAppPlatform.appPlatform.appId, {
        ...eventAppPlatform.appPlatform.app,
        appPlatforms: [],
      });
    }
    const currentValues = appsMap.get(eventAppPlatform.appPlatform.appId);
    invariant(currentValues, "Failed to find app");
    appsMap.set(eventAppPlatform.appPlatform.appId, {
      ...currentValues,
      appPlatforms: [
        ...currentValues.appPlatforms,
        {
          ...omit(eventAppPlatform.appPlatform, "app"),
          eventAppPlatform: {
            id: eventAppPlatform.id,
            status: eventAppPlatform.status,
            comment: eventAppPlatform.comment,
          },
        },
      ],
    });

    platformsMap.set(eventAppPlatform.appPlatform.platform.id, {
      id: eventAppPlatform.appPlatform.platform.id,
      name: eventAppPlatform.appPlatform.platform.name,
      type: eventAppPlatform.appPlatform.platform.type,
    });
  });

  return { appsMap, platformsMap };
}

export async function loader({ request, params }: LoaderArgs) {
  await requireAdminUser(request);
  invariant(params.eventId, "Invalid event ID");

  const { appsMap, platformsMap } = await getApps(params.eventId);
  const appData = [...appsMap.values()];
  const platformsData = [...platformsMap.values()];

  const additionalPlatformsForAppsMap = new Map<
    string,
    Array<{ appPlatformId: string; platform: { id: string; name: string } }>
  >();
  (
    await prisma.appPlatform.findMany({
      where: { appId: { in: [...appsMap.keys()] } },
      select: {
        appId: true,
        id: true,
        platform: { select: { id: true, name: true, type: true } },
      },
    })
  ).forEach((appPlatform) => {
    if (!additionalPlatformsForAppsMap.has(appPlatform.appId)) {
      additionalPlatformsForAppsMap.set(appPlatform.appId, []);
    }

    if (
      (
        appsMap.get(appPlatform.appId) ?? { appPlatforms: [] }
      ).appPlatforms.findIndex(
        (p) => p.platformId === appPlatform.platform.id
      ) === -1
    ) {
      additionalPlatformsForAppsMap.set(appPlatform.appId, [
        ...(additionalPlatformsForAppsMap.get(appPlatform.appId) ?? []),
        {
          appPlatformId: appPlatform.id,
          platform: appPlatform.platform,
        },
      ]);
    }
  });
  const additionalPlatformsForApps = Object.fromEntries([
    ...additionalPlatformsForAppsMap.entries(),
  ]);

  const appList = await prisma.app.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const platformList = await prisma.platform.findMany({
    where: {
      appPlatforms: {
        some: { eventAppPlatforms: { every: { eventId: params.eventId } } },
      },
    },
    select: { id: true, name: true, type: true },
    orderBy: { name: "asc" },
  });

  const studioIdsMap = new Set<Studio["id"]>();
  appData.forEach((app) => {
    studioIdsMap.add(app.studioId);
  });

  const studioList = await prisma.studio.findMany({
    where: { id: { in: [...studioIdsMap.values()] } },
    select: {
      id: true,
      name: true,
      mainContact: {
        select: { user: { select: { id: true, name: true, email: true } } },
      },
    },
    orderBy: { name: "asc" },
  });

  return typedjson({
    appData,
    platformsData,
    appList,
    platformList,
    additionalPlatformsForApps,
    studioList,
  });
}

export const handle: PageHandle = { breadcrumb: () => "App admin" };

export default function EventAppAdmin() {
  const data = useTypedLoaderData<typeof loader>();

  const fetcherPlatformEdit = useFetcher<typeof action>();
  const fetcherPlatformDelete = useFetcher<typeof action>();
  const fetcherPlatformAdd = useFetcher<typeof action>();

  const [searchParams] = useSearchParams();
  const searchParamsSchema = z.object({
    editAppId: z.string().optional(),
    filters: z
      .object({
        platform: z.string().array(),
        studio: z.string().array(),
        status: z.nativeEnum(EventAppPlatformStatus).array(),
        type: z.nativeEnum(AppType).array(),
      })
      .partial()
      .optional(),
  });
  type SearchParamsSchema = z.infer<typeof searchParamsSchema>;

  const parsedSearchParams = searchParamsSchema.safeParse(
    qs.parse(searchParams.toString())
  );

  const gridCols = 4 + data.platformsData.length;

  let filteredPlatformsData = data.platformsData;
  let filteredAppData = data.appData;

  if (
    parsedSearchParams.success &&
    typeof parsedSearchParams.data.filters !== "undefined"
  ) {
    const filters = parsedSearchParams.data.filters;
    const platformsMap = new Map<
      Platform["id"],
      { id: Platform["id"]; name: Platform["name"]; type: Platform["type"] }
    >();

    filteredAppData = filteredAppData.filter((app) => {
      if (typeof filters.studio !== "undefined") {
        const hasStudio = filters.studio.includes(app.studioId);
        if (!hasStudio) {
          return false;
        }
      }

      if (typeof filters.type !== "undefined") {
        const hasAppType = filters.type.includes(app.type);
        if (!hasAppType) {
          return false;
        }
      }

      const index = app.appPlatforms.findIndex((appPlatform) => {
        let filterSuccesses = [];

        if (typeof filters.status !== "undefined") {
          const hasStatus = filters.status.includes(
            appPlatform.eventAppPlatform.status
          );
          filterSuccesses.push(hasStatus);
        }

        if (typeof filters.platform !== "undefined") {
          const hasPlatform = filters.platform.includes(appPlatform.platformId);
          filterSuccesses.push(hasPlatform);
        }

        const isSuccessful =
          filterSuccesses.length === 0 ||
          filterSuccesses.every((state) => state === true);

        if (isSuccessful) {
          platformsMap.set(appPlatform.platform.id, {
            id: appPlatform.platform.id,
            name: appPlatform.platform.name,
            type: appPlatform.platform.type,
          });
        }
        return isSuccessful;
      });
      return index > -1;
    });
    filteredPlatformsData = [...platformsMap.values()];
  }

  const filteredStudioMap = new Map<
    Studio["id"],
    typeof data["studioList"][number]
  >();
  filteredAppData.forEach((app) =>
    filteredStudioMap.set(
      app.studioId,
      data.studioList.find((studio) => studio.id === app.studioId)!
    )
  );
  const filteredStudioList = Object.fromEntries([
    ...filteredStudioMap.entries(),
  ]);

  const studioEmails = Object.values(filteredStudioList)
    .map((studio) =>
      studio.mainContact
        ? `"${studio.mainContact.user.name} - ${studio.name}" <${studio.mainContact.user.email}>`
        : null
    )
    .filter((emails) => emails !== null)
    .join(", ");

  const steamSaleDataExportMissingLinks: Array<{
    appId: string;
    appName: string;
    appPlatformId: string;
    platformName: string;
  }> = [];

  const steamSaleDataExport = filteredAppData
    .flatMap((app) => {
      const steamSaleData: string[] = [];

      app.appPlatforms.forEach((appPlatform) => {
        if (appPlatform.platform.type !== PlatformType.Steam) {
          return;
        }

        let hasSteamLink = false;

        appPlatform.links.forEach((link) => {
          const match = link.url.match(
            /\/store\.steampowered\.com\/(app|sub|bundle)\/(\d+)/
          );
          if (!match) {
            return;
          }

          hasSteamLink = true;

          const [, steamType, appid] = match;

          const tags: string[] = [];
          tags.push(`[Custom] Release state: ${appPlatform.releaseState}`);
          if (appPlatform.isEarlyAccess) tags.push("[Custom] Early Access");
          if (appPlatform.isFreeToPlay) tags.push("[Custom] Free to play");

          const row: string[] = [];
          row.push(appid);
          row.push(steamType === "app" ? "game" : steamType);
          if (tags.length > 0) row.push(`"${tags.join(";")}"`);
          row.push(`// ${app.name} - ${link.title}`);

          steamSaleData.push(row.join("\t"));
        });

        if (!hasSteamLink) {
          steamSaleDataExportMissingLinks.push({
            appId: app.id,
            appName: app.name,
            appPlatformId: appPlatform.id,
            platformName: appPlatform.platform.name,
          });
        }
      });

      return steamSaleData;
    })
    .join("\n");

  function isSavingOrDeletingPlatform(
    fetcher: typeof fetcherPlatformEdit | typeof fetcherPlatformDelete,
    eventAppPlatformId: EventAppPlatform["id"]
  ) {
    return (
      fetcher.state === "submitting" &&
      fetcher.submission?.formData.get("eventAppPlatformId") ===
        eventAppPlatformId
    );
  }

  function appendToQuery(objToAppend: SearchParamsSchema): SearchParamsSchema {
    const currentParams = parsedSearchParams.success
      ? parsedSearchParams.data
      : {};

    function uniqFilter<T extends string = string>(
      key: NonNullable<keyof NonNullable<SearchParamsSchema["filters"]>>
    ): T[] {
      return [
        ...new Set(
          ((currentParams.filters?.[key] as T[]) ?? []).concat(
            (objToAppend.filters?.[key] as T[]) ?? []
          )
        ),
      ];
    }

    return {
      editAppId:
        objToAppend.editAppId === currentParams.editAppId
          ? undefined
          : objToAppend.editAppId ?? currentParams.editAppId,
      filters: {
        platform: uniqFilter("platform"),
        status: uniqFilter("status"),
        studio: uniqFilter("studio"),
        type: uniqFilter("type"),
      },
    };
  }

  function generateQueryLink(
    objToAppendToQuery: z.infer<typeof searchParamsSchema>
  ) {
    return `./?${qs.stringify(appendToQuery(objToAppendToQuery), {
      arrayFormat: "brackets",
    })}`;
  }

  return (
    <div>
      <h3>Event apps</h3>
      <div className="mb-4">
        <Outlet />
      </div>
      {parsedSearchParams.success &&
        typeof parsedSearchParams.data.filters !== "undefined" &&
        Object.keys(parsedSearchParams.data.filters).length > 0 && (
          <div className="py-2 px-4 my-2 bg-warning-bg w-fit">
            <p>
              You have filters enabled.{" "}
              <Link
                to=""
                className="text-link-warning hover:text-link-warning-hover"
              >
                Disable filters
              </Link>
            </p>
            {(
              Object.entries(parsedSearchParams.data.filters) as Entries<
                typeof parsedSearchParams.data.filters
              >
            ).map(([filterName, values]) => {
              const names = values?.map((val) => {
                let name = "";
                if (filterName === "platform") {
                  data.platformsData.find((p) => {
                    return p.id === val;
                  });
                  name =
                    data.platformsData.find((p) => p.id === val)?.name ??
                    "Unknown platform";
                } else if (filterName === "studio") {
                  const app = data.appData.find((app) => app.studioId === val);
                  name = app
                    ? filteredStudioList[app.studioId]?.name ?? val
                    : val;
                } else {
                  name = val;
                }

                return name;
              });

              return (
                <p key={filterName} className="text-sm">
                  {filterName}: {names?.join(" OR ")}
                </p>
              );
            })}
          </div>
        )}

      <p>
        Currently viewing {filteredAppData.length} apps on{" "}
        {filteredPlatformsData.length} platforms by{" "}
        {[...new Set(filteredAppData.map((app) => app.studioId))].length}{" "}
        studios
      </p>

      <h4>Studios</h4>
      <details>
        <summary>Toggle more info about studios</summary>
        {parsedSearchParams.success &&
          typeof parsedSearchParams.data.filters !== "undefined" &&
          Object.keys(parsedSearchParams.data.filters).length > 0 && (
            <div>
              <h5>Filtered studios</h5>

              <details>
                <summary>Toggle filtered studio list</summary>
                <ul>
                  {Object.values(filteredStudioList).map((studio) => (
                    <li key={studio.id}>
                      <Link to={`/admin/studios/${studio.id}`}>
                        {studio.name}
                      </Link>{" "}
                      (
                      <Link
                        to={generateQueryLink({
                          filters: { studio: [studio.id] },
                        })}
                      >
                        filter
                      </Link>
                      )
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}

        <div>
          <h5>Full studio list</h5>
          <details className="w-full">
            <summary>Toggle email formatting for filtered results</summary>
            <div>
              <a href={`mailto:undisclosed-recipients?bcc=${studioEmails}`}>
                Send email
              </a>
            </div>
            <textarea
              rows={6}
              className="w-1/2"
              readOnly
              value={studioEmails}
            ></textarea>
          </details>
          <details>
            <summary>Toggle full studio list</summary>
            <p>
              This list includes ALL studios, even when they aren't visible now.
              It's here so you can filter by multiple studios.
            </p>
            <ul>
              {Object.values(data.studioList).map((studio) => (
                <li key={studio.id}>
                  <Link to={`/admin/studios/${studio.id}`}>{studio.name}</Link>{" "}
                  (
                  <Link
                    to={generateQueryLink({ filters: { studio: [studio.id] } })}
                  >
                    filter
                  </Link>
                  )
                </li>
              ))}
            </ul>
          </details>
        </div>
      </details>

      <h4>Exports</h4>
      <details>
        <summary>Toggle exports</summary>
        {filteredPlatformsData.findIndex(
          (platform) => platform.type === PlatformType.Steam
        ) > -1 && (
          <details>
            <summary>Export Steam sale data</summary>
            <textarea
              className="resize w-96 h-64"
              readOnly
              value={steamSaleDataExport}
            ></textarea>
            {steamSaleDataExportMissingLinks.length > 0 && (
              <div>
                <p>
                  <strong>Warning:</strong> These apps with a Steam platform
                  don't have any Steam links:
                </p>
                <ul>
                  {steamSaleDataExportMissingLinks.map((app) => (
                    <li key={app.appPlatformId}>
                      <Link to={`/admin/apps/${app.appId}`}>{app.appName}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </details>
        )}
      </details>

      <h4>App list</h4>

      <table className="table-auto w-full relative">
        <thead>
          <tr>
            <th className="sticky left-0 top-auto bg-secondary">App</th>
            <th>Studio</th>
            <th>Type</th>
            {filteredPlatformsData.map((platform) => (
              <th key={platform.id} className="text-center">
                <Link
                  to={generateQueryLink({
                    filters: { platform: [platform.id] },
                  })}
                >
                  {platform.name}
                </Link>
              </th>
            ))}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filteredAppData.map((app) => (
            <Fragment key={app.id}>
              <tr>
                <td className="sticky left-0 top-auto bg-secondary">
                  <div className="max-w-[20vw] truncate pr-2">
                    <Link to={`/admin/apps/${app.id}`} title={app.name}>
                      {app.name}
                    </Link>
                  </div>
                </td>
                <td className="w-max max-w-[10rem] truncate px-2">
                  <span className="pr-1">
                    <Link
                      to={generateQueryLink({
                        filters: { studio: [app.studioId] },
                      })}
                    >
                      (f)
                    </Link>
                  </span>
                  <Link
                    to={`/admin/studios/${app.studioId}`}
                    className="text-ellipsis"
                  >
                    {data.studioList.find(
                      (studio) => studio.id === app.studioId
                    )?.name ?? app.studioId}
                  </Link>
                </td>
                <td>
                  <Link
                    to={generateQueryLink({ filters: { type: [app.type] } })}
                  >
                    {app.type}
                  </Link>
                </td>
                {filteredPlatformsData.map((platform) => {
                  const appPlatform = app.appPlatforms.find(
                    (p) => p.platformId === platform.id
                  );

                  let platformTitle = [
                    `Platform: ${platform.name}`,
                    isPlatformStatusOK(appPlatform?.eventAppPlatform.status)
                      ? "Included in event"
                      : data.additionalPlatformsForApps[app.id].length === 0
                      ? "Platform not available for this app"
                      : "Not included in event",
                  ];
                  if (appPlatform) {
                    platformTitle.push(
                      `Release state: ${appPlatform.releaseState}`
                    );
                    platformTitle.push(
                      `Early Access: ${
                        appPlatform.isEarlyAccess ? "yes" : "no"
                      }`
                    );
                    platformTitle.push(
                      `F2P: ${appPlatform.isFreeToPlay ? "yes" : "no"}`
                    );
                    if (appPlatform.comment) {
                      platformTitle.push("");
                      platformTitle.push(
                        `Platform comment:\n${appPlatform.comment}`
                      );
                    }
                    if (appPlatform.eventAppPlatform.comment) {
                      platformTitle.push("");
                      platformTitle.push(
                        `Event comment:\n${appPlatform.eventAppPlatform.comment}`
                      );
                    }
                  }

                  return (
                    <td
                      key={platform.id}
                      className="text-center"
                      title={platformTitle.join("\n")}
                    >
                      {typeof appPlatform !== "undefined" ? (
                        <>
                          <input
                            type="checkbox"
                            disabled
                            checked={isPlatformStatusOK(
                              appPlatform?.eventAppPlatform.status
                            )}
                          />
                          <div className="text-xs">
                            <p>
                              <Link
                                to={generateQueryLink({
                                  filters: {
                                    status: [
                                      appPlatform.eventAppPlatform.status,
                                    ],
                                  },
                                })}
                              >
                                {appPlatform.eventAppPlatform.status}
                              </Link>
                              {appPlatform.isEarlyAccess && " | EA"}
                              {appPlatform.isFreeToPlay && " | F2P"}
                            </p>
                            {(appPlatform.comment ||
                              appPlatform.eventAppPlatform.comment) && (
                              <p>Has comment</p>
                            )}
                          </div>
                        </>
                      ) : data.additionalPlatformsForApps[app.id].findIndex(
                          (additionalApp) =>
                            additionalApp.platform.id === platform.id
                        ) > -1 ? (
                        <input type="checkbox" disabled />
                      ) : (
                        "-"
                      )}
                    </td>
                  );
                })}
                <td>
                  <Link
                    to={generateQueryLink({ editAppId: app.id })}
                    className="link-button"
                  >
                    {parsedSearchParams.success &&
                    parsedSearchParams.data.editAppId === app.id
                      ? "Close"
                      : "Edit"}
                  </Link>
                </td>
              </tr>
              {parsedSearchParams.success &&
                parsedSearchParams.data.editAppId === app.id && (
                  <tr>
                    <td colSpan={gridCols} className="bg-secondary-section p-4">
                      <h4>App platforms in event</h4>
                      <div className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2">
                        {app.appPlatforms.map((platform) => {
                          const isSavingPlatform = isSavingOrDeletingPlatform(
                            fetcherPlatformEdit,
                            platform.eventAppPlatform.id
                          );
                          const isDeletingPlatform = isSavingOrDeletingPlatform(
                            fetcherPlatformDelete,
                            platform.eventAppPlatform.id
                          );

                          return (
                            <Fragment key={platform.id}>
                              <p>
                                {
                                  data.platformsData.find(
                                    (p) => p.id === platform.platformId
                                  )?.name
                                }
                              </p>
                              <div className="flex gap-2 items-center">
                                <fetcherPlatformEdit.Form method="post">
                                  <fieldset
                                    disabled={isSavingPlatform}
                                    className="flex gap-2 items-center"
                                  >
                                    <input
                                      type="hidden"
                                      name="eventAppPlatformId"
                                      value={platform.eventAppPlatform.id}
                                    />
                                    <input
                                      type="hidden"
                                      name="appPlatformId"
                                      value={platform.id}
                                    />
                                    <label
                                      htmlFor={`event_status_${platform.eventAppPlatform.id}`}
                                    >
                                      Status
                                    </label>
                                    <select
                                      name="status"
                                      defaultValue={
                                        platform.eventAppPlatform.status
                                      }
                                      id={`event_status_${platform.eventAppPlatform.id}`}
                                    >
                                      {Object.entries(
                                        EventAppPlatformStatus
                                      ).map(([key, name]) => (
                                        <option key={key}>{name}</option>
                                      ))}
                                    </select>
                                    <label
                                      htmlFor={`comment_${platform.eventAppPlatform.id}`}
                                    >
                                      Comment
                                    </label>
                                    <textarea
                                      name="comment"
                                      id={`comment_${platform.eventAppPlatform.id}`}
                                      defaultValue={
                                        platform.eventAppPlatform.comment ?? ""
                                      }
                                      rows={1}
                                    />
                                    <button
                                      type="submit"
                                      name="intent"
                                      value={Intent.EditPlatform}
                                      className="button-primary py-0 px-1"
                                    >
                                      {isSavingPlatform ? "Saving..." : "Save"}
                                    </button>
                                  </fieldset>
                                </fetcherPlatformEdit.Form>
                                <fetcherPlatformDelete.Form method="delete">
                                  <fieldset disabled={isDeletingPlatform}>
                                    <input
                                      type="hidden"
                                      name="eventAppPlatformId"
                                      value={platform.eventAppPlatform.id}
                                    />
                                    <button
                                      type="submit"
                                      name="intent"
                                      value={Intent.DeletePlatform}
                                      className="button-destructive px-1 py-0"
                                    >
                                      {isDeletingPlatform
                                        ? "Removing..."
                                        : "Remove"}
                                    </button>
                                  </fieldset>
                                </fetcherPlatformDelete.Form>
                              </div>
                            </Fragment>
                          );
                        })}
                      </div>
                      {data.additionalPlatformsForApps[app.id].length > 0 && (
                        <details>
                          <summary>Add new platform</summary>
                          <fetcherPlatformAdd.Form method="post">
                            <fieldset
                              disabled={fetcherPlatformAdd.state !== "idle"}
                              className="border px-4 pb-2 w-fit"
                            >
                              <legend>New platform</legend>
                              <div className="grid grid-cols-[auto_auto] gap-4 w-fit">
                                <label htmlFor="new_platform">Platform</label>
                                <select
                                  name="appPlatformId"
                                  id="new_platform"
                                  defaultValue=""
                                >
                                  <EmptyOption />
                                  {data.additionalPlatformsForApps[app.id].map(
                                    (appPlatform) => (
                                      <option
                                        key={appPlatform.appPlatformId}
                                        value={appPlatform.appPlatformId}
                                      >
                                        {appPlatform.platform.name}
                                      </option>
                                    )
                                  )}
                                </select>
                                <label htmlFor="new_platform_status">
                                  Status
                                </label>
                                <select
                                  name="status"
                                  id="new_platform_status"
                                  defaultValue=""
                                >
                                  <EmptyOption />
                                  {Object.keys(EventAppPlatformStatus).map(
                                    (status) => (
                                      <option key={status} value={status}>
                                        {status}
                                      </option>
                                    )
                                  )}
                                </select>
                                <label htmlFor="new_platform_comment">
                                  Comment
                                </label>
                                <textarea
                                  name="comment"
                                  id="new_platform_comment"
                                />
                              </div>
                              <button
                                type="submit"
                                name="intent"
                                value={Intent.AddPlatform}
                                disabled={fetcherPlatformAdd.state !== "idle"}
                                className="button-primary mt-2"
                              >
                                {fetcherPlatformAdd.state !== "idle"
                                  ? "Adding..."
                                  : "Add"}
                              </button>
                            </fieldset>
                          </fetcherPlatformAdd.Form>
                        </details>
                      )}
                    </td>
                  </tr>
                )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
