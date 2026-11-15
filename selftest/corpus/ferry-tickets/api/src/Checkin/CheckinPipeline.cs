namespace Ferry.Api.Checkin;

public class CheckinRequest
{
    public int Ticket { get; set; }
    public bool Valid { get; set; } = true;
}

public interface ICheckinStep
{
    Task ProcessAsync(CheckinRequest request);
}

public interface ICheckinPipeline
{
    Task<CheckinRequest> ProcessAsync(CheckinRequest request);
}

public class CheckinPipeline : ICheckinPipeline
{
    private readonly List<ICheckinStep> _steps = new List<ICheckinStep>();

    public void RegisterStep(ICheckinStep step)
    {
        _steps.Add(step);
    }

    public async Task<CheckinRequest> ProcessAsync(CheckinRequest request)
    {
        foreach (var step in _steps)
        {
            await step.ProcessAsync(request);
            if (!request.Valid) return null;
        }

        return request;
    }
}
