namespace Ferry.Api.Checkin;

public class TicketStep : ICheckinStep
{
    private readonly ITicketPackage _package;

    public TicketStep(ITicketPackage package)
    {
        _package = package;
    }

    public async Task ProcessAsync(CheckinRequest request)
    {
        _package.Validate(request.Ticket);
        await Task.CompletedTask;
    }
}

public class AccessStep : ICheckinStep
{
    private readonly ISeatAccess _access;

    public AccessStep(ISeatAccess access)
    {
        _access = access;
    }

    public async Task ProcessAsync(CheckinRequest request)
    {
        _access.Require(request.Ticket);
        await Task.CompletedTask;
    }
}

public class PierStep : ICheckinStep
{
    private readonly IPierDesk _desk;

    public PierStep(IPierDesk desk)
    {
        _desk = desk;
    }

    public async Task ProcessAsync(CheckinRequest request)
    {
        _desk.Open(request.Ticket);
        await Task.CompletedTask;
    }
}
