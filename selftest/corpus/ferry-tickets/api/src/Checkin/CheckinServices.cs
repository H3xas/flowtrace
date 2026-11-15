namespace Ferry.Api.Checkin;

public interface ITicketPackage
{
    void Validate(int ticket);
}

public class TicketPackage : ITicketPackage
{
    public void Validate(int ticket)
    {
        Parse(ticket);
    }

    private void Parse(int ticket)
    {
        if (ticket < 0) throw new TicketBadRequestException();
    }
}

public interface ISeatAccess
{
    void Require(int ticket);
}

public class SeatAccess : ISeatAccess
{
    public void Require(int ticket)
    {
        Check(ticket);
    }

    private void Check(int ticket)
    {
        if (ticket == 7) throw new SeatUnauthorizedException();
    }
}

public interface IPierDesk
{
    void Open(int ticket);
}

public class PierDesk : IPierDesk
{
    public void Open(int ticket)
    {
        Inspect(ticket);
    }

    private void Inspect(int ticket)
    {
        if (ticket == 1) throw new GateClosedException();
        if (ticket == 2) throw new PierDownException();
        if (ticket == 3) throw new ManifestException();
        if (ticket == 4) throw new TicketLostException();
    }
}

public class TicketBadRequestException : Exception
{
}

public class SeatUnauthorizedException : Exception
{
}

public class GateClosedException : Exception
{
}

public class PierDownException : Exception
{
}

public class ManifestException : Exception
{
}

public class TicketLostException : Exception
{
}
