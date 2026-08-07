import { initials } from "./initials";

type Props = {
  name: string;
  avatarUrl?: string | null;
  className?: string;
  online?: boolean;
  title?: string;
};

export function Avatar({ name, avatarUrl, className = "avatar", online = false, title }: Props) {
  const classes = `${className}${online ? " online" : ""}`;
  if (avatarUrl) {
    return <img alt="" className={`${classes} photo`} src={avatarUrl} title={title} />;
  }
  return <span className={classes} title={title}>{initials(name)}</span>;
}
