using System.Collections.Generic;

namespace KilnYard.Api.Services
{
    public interface IFiringService
    {
        IList<string> List(string kilnId);
    }

    public class FiringService : IFiringService
    {
        public IList<string> List(string kilnId)
        {
            var firings = new List<string>();
            if (kilnId.Length > 3)
            {
                firings.Add(kilnId);
            }
            else
            {
                firings.Add("short");
            }
            return firings;
        }
    }
}
