import { getTranslations } from "next-intl/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireUser } from "@/services/auth/dal";
import { CreateFundForm } from "./create-fund-form";

export default async function NewFundPage() {
  // (apex) layout already bounced any non-apex host here, so there's no fund
  // context to worry about — getCurrentFund would always be null.
  await requireUser();

  const t = await getTranslations("funds.create");

  return (
    <div className="flex flex-1 items-start justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>
              {t.rich("description", {
                code: (chunks) => <code>{chunks}</code>,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateFundForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
