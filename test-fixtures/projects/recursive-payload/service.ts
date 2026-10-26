import { db } from "./client";

export const recent = async (author: string) => {
  const articles = await db.article.findMany({
    where: { author: { name: author } },
    include: { author: true, tags: true }
  });
  const user = await db.user.findUnique({ where: { name: author } });
  return { articles, user, count: articles.length };
};

export const title = (name: string) => name.trim();
