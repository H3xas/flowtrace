namespace Ferry.Api.Embark;

public class EmbarkRequest
{
    public int Ticket { get; set; }
    public int Deck { get; set; }
    public bool Badge { get; set; }
    public bool Valid { get; set; } = true;
}

public interface IEmbarkStep
{
    bool ShouldExecute(EmbarkRequest request);
    Task ProcessAsync(EmbarkRequest request);
}

public interface IEmbarkPipeline
{
    Task<EmbarkRequest> ProcessAsync(EmbarkRequest request);
}

public class EmbarkPipeline : IEmbarkPipeline
{
    private readonly List<IEmbarkStep> _steps = new List<IEmbarkStep>();

    public void RegisterStep(IEmbarkStep step)
    {
        _steps.Add(step);
    }

    public async Task<EmbarkRequest> ProcessAsync(EmbarkRequest request)
    {
        foreach (var step in _steps)
        {
            if (!step.ShouldExecute(request)) continue;
            await step.ProcessAsync(request);
            if (!request.Valid) return null;
        }

        return request;
    }
}
