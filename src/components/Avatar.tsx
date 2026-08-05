import { initials } from "./initials";

type Props = {
  name: string;
  avatarUrl?: string | null;
  className?: string;
  title?: string;
};

export function Avatar({ name, avatarUrl, className = "avatar", title }: Props) {
  if (avatarUrl) {
    return <img alt="" className={`${className} photo`} src={avatarUrl} title={title} />;
  }
  return <span className={className} title={title}>{initials(name)}</span>;
}
