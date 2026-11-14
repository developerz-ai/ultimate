create table plans (
  id uuid primary key, code text not null, seats integer not null,
  monthly_minor bigint not null, monthly_currency char(3) not null, monthly_scale smallint
);
create table notes (body text not null);
